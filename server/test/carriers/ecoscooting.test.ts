import { describe, expect, it } from "vitest";
import { ecoscooting } from "../../src/carriers/ecoscooting/index.js";
import { register } from "../../src/engine/registry.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { harness, scripted } from "./kit-harness-3.js";

// Made-up references and values only.
const CODE = "ECTEST00000001";
const ROUTE = "POST de-link.cainiao.com/gateway/link.do";
const plugin = register(ecoscooting);

const step = (actionCode: string, opTimestamp: string, statusName: string) => ({
  actionCode,
  opTimestamp,
  statusName,
  timezone: "1",
});

function reply(...statuses: ReturnType<typeof step>[]) {
  return {
    success: "true",
    packageParam: { trackingNumber: CODE, dimWeight: { weight: "1250", weightUnit: "g" } },
    popStationParam: { stationName: "Example Locker, NaN", detailAddress: "Test Street 1" },
    statuses,
  };
}

describe("Ecoscooting tracking", () => {
  it("maps the newest code and turns out-for-delivery into a window to the day's end", async () => {
    const { fetchImpl, calls } = scripted({
      [ROUTE]: [
        {
          status: 200,
          body: reply(
            step("LM_DELIVERY_DEPART", "1763452800000", "Out for delivery"),
            step("SC_INBOUND", "1763380800000", "Arrived at sorting centre"),
          ),
        },
      ],
    });
    const { base, unknown } = harness(ecoscooting.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(new URLSearchParams(calls[0]?.body ?? "").get("logistics_interface")).toContain(CODE);
    expect(found).toMatchObject({
      carrier: "ecoscooting",
      status: "out_for_delivery",
      rawStatus: "Out for delivery",
      plannedFrom: "2025-11-18T08:00:00.000Z",
      plannedTo: "2025-11-18T22:59:59.000Z",
      pickupPoint: "Example Locker, Test Street 1",
      weightKg: 1.25,
    });
    expect(found?.history.map((event) => event.status)).toEqual(["out_for_delivery", "in_transit"]);
    expect(unknown).toEqual([]);
  });

  it("maps return codes by their prefix and treats the query-failed code as not found", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [
        { status: 200, body: reply(step("RT_SOMETHING", "1763452800000", "Returning")) },
        { status: 200, body: { success: "false", errorCode: "P-011-0201-00-00-502" } },
      ],
    });
    const { base } = harness(ecoscooting.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots[0]?.status).toBe("returning");
    expect((await plugin.track(base, {}, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown code but falls back to the newest known one", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [
        {
          status: 200,
          body: reply(
            step("NEW_CODE", "1763452800000", "New"),
            step("SC_INBOUND", "1763380800000", "Sorted"),
          ),
        },
      ],
    });
    const { base, unknown } = harness(ecoscooting.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots[0]?.status).toBe("in_transit");
    expect(unknown).toEqual(["status:NEW_CODE"]);
  });

  it("stops when the answer is for another reference", async () => {
    const other = { ...reply(), packageParam: { trackingNumber: "OTHER0000001" } };
    const { fetchImpl } = scripted({ [ROUTE]: [{ status: 200, body: other }] });
    const { base } = harness(ecoscooting.http, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
