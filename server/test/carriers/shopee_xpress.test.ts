import { describe, expect, it } from "vitest";
import { shopeeXpress } from "../../src/carriers/shopee_xpress/index.js";
import { TransientError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(shopeeXpress);

// Made-up codes and values only.
const CODE = "SPXTEST00000001";
const OTHER = "SPXTEST00000002";
const ROUTE = "GET spx.com.my/shipment/order/open/order/get_order_info";
const config = { market: "MY" };

const record = (milestone_code: number, actual_time: number, text: string, display_flag = 1) => ({
  milestone_code,
  actual_time,
  buyer_description: text,
  display_flag,
});

const found = (records: unknown[], extra: object = {}): Answer =>
  json(
    {
      retcode: 0,
      message: "success",
      data: {
        order_info: { spx_tn: CODE },
        sls_tracking_info: { receiver_name: "T*** P***", records },
        ...extra,
      },
    },
    200,
  );

describe("Shopee Xpress tracking", () => {
  it("reads the milestone, the estimate window and the visible history", async () => {
    const { fetchImpl, calls } = network({
      [ROUTE]: [
        found(
          [
            record(6, 1_795_000_000, "Out for delivery"),
            record(5, 1_794_990_000, "internal", 0),
            record(5, 1_794_900_000, "Arrived at hub"),
            record(1, 1_794_800_000, "Order created"),
          ],
          { edd_info: { edd_min: 1_795_010_000, edd_max: 1_795_020_000 } },
        ),
      ],
    });
    const { base } = fakeContext(shopeeXpress.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    expect(result.complete).toBe(true);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "shopee_xpress",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "Out for delivery",
      plannedFrom: new Date(1_795_010_000_000).toISOString(),
      plannedTo: new Date(1_795_020_000_000).toISOString(),
      url: `https://spx.com.my/track?${CODE}`,
    });
    expect(result.snapshots[0]?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(calls[0]?.url.searchParams.get("language_code")).toBe("ms");
  });

  it("drops the window once delivered", async () => {
    const { fetchImpl } = network({
      [ROUTE]: [
        found([record(8, 1_795_000_000, "Delivered")], {
          edd_info: { edd_min: 1_795_010_000, edd_max: 1_795_020_000 },
        }),
      ],
    });
    const { base } = fakeContext(shopeeXpress.http, fetchImpl);
    const [parcel] = (await plugin.track(base, config, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ delivered: true, plannedFrom: null, plannedTo: null });
  });

  it("skips an error envelope without calling the result complete", async () => {
    const { fetchImpl, calls } = network({
      [ROUTE]: [json({ retcode: 2, message: "record not unique" }, 200)],
    });
    const { base } = fakeContext(shopeeXpress.http, fetchImpl);
    const result = await plugin.track(base, config, null, [OTHER, "../x"]);
    expect(result).toEqual({ snapshots: [], complete: false });
    expect(calls).toHaveLength(1);
  });

  it("reports an unknown milestone code", async () => {
    const { fetchImpl } = network({ [ROUTE]: [found([record(42, 1_795_000_000, "New")])] });
    const { base, unknownKeys: unknown } = fakeContext(shopeeXpress.http, fetchImpl);
    const [parcel] = (await plugin.track(base, config, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["42"]);
  });

  it("stops on HTTP errors and answers without a result code", async () => {
    const one = fakeContext(shopeeXpress.http, network({ [ROUTE]: [json({}, 502)] }).fetchImpl);
    await expect(plugin.track(one.base, config, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
    const two = fakeContext(shopeeXpress.http, network({ [ROUTE]: [json({}, 200)] }).fetchImpl);
    await expect(plugin.track(two.base, config, null, [CODE])).rejects.toThrow(/result code/);
  });
});
