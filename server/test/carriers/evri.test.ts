import { describe, expect, it } from "vitest";
import { evri } from "../../src/carriers/evri/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError } from "../../src/plugin/errors.js";
import { harness, scripted } from "./kit-harness-3.js";

// Made-up barcodes, ids and postcodes only.
const CODE = "EV00000000000001";
const URN = "urn:test:parcel:1";
const CONFIG = { postalCode: "zz9 9zz" };
const REFERENCE = `GET tracking.platform-apis.evri.com/v1/parcels/reference/${CODE}`;
const DETAIL = "GET tracking.platform-apis.evri.com/v1/parcels";
const plugin = register(evri);

const stage = (code: string, dateTime: string) => ({
  dateTime,
  trackingStage: { trackingStageCode: code },
  trackingPoint: { trackingPointCode: "PROCESSING_HUB" },
});

function parcel(...events: ReturnType<typeof stage>[]) {
  return {
    results: [
      {
        parcelIdentifiers: [{ value: CODE }],
        sender: { displayName: "Example Shop" },
        recipient: { name: "Test Person" },
        trackingEvents: events,
      },
    ],
  };
}

describe("Evri tracking", () => {
  it("resolves the id, looks the parcel up with the postcode and remembers the id", async () => {
    const { fetchImpl, calls } = scripted({
      [REFERENCE]: [{ status: 200, body: { parcelIdentifiers: [{ urn: URN }] } }],
      [DETAIL]: [
        {
          status: 200,
          body: parcel(
            stage("2", "2026-11-17T10:00:00Z"),
            stage("4_COURIER", "2026-11-18T07:00:00Z"),
          ),
        },
      ],
    });
    const { base, saved, unknown } = harness(evri.http, fetchImpl);
    const [found] = (await plugin.track(base, CONFIG, null, [CODE])).snapshots;
    expect(calls[1]?.url.searchParams.get("postcode")).toBe("ZZ9 9ZZ");
    expect(calls[1]?.url.searchParams.get("uniqueIds")).toBe(URN);
    expect(calls[0]?.headers.get("apikey")).not.toBeNull();
    expect(found).toMatchObject({
      carrier: "evri",
      status: "out_for_delivery",
      rawStatus: "4_COURIER",
      sender: "Example Shop",
      plannedFrom: null,
    });
    expect(found?.history.map((event) => event.status)).toEqual(["out_for_delivery", "in_transit"]);
    expect(JSON.stringify(found?.raw)).not.toContain("Test Person");
    expect(saved).toEqual([{ [CODE]: URN }]);
    expect(unknown).toEqual([]);
  });

  it("uses a remembered id without resolving again and dates the delivery", async () => {
    const { fetchImpl, calls } = scripted({
      [DETAIL]: [{ status: 200, body: parcel(stage("5_SHOP", "2026-11-18T12:00:00Z")) }],
    });
    const { base } = harness(evri.http, fetchImpl, { [CODE]: URN });
    const [found] = (await plugin.track(base, CONFIG, null, [CODE])).snapshots;
    expect(calls).toHaveLength(1);
    expect(found).toMatchObject({ status: "delivered", deliveredAt: "2026-11-18T12:00:00.000Z" });
  });

  it("treats an invalid reference as not found", async () => {
    const { fetchImpl } = scripted({
      [REFERENCE]: [{ status: 400, body: { errors: [{ message: "Invalid reference: x" }] } }],
    });
    const { base } = harness(evri.http, fetchImpl);
    expect((await plugin.track(base, CONFIG, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown stage and treats a refused website key as transient", async () => {
    const { fetchImpl } = scripted({
      [DETAIL]: [
        { status: 200, body: parcel(stage("9_NEW", "2026-11-18T12:00:00Z")) },
        { status: 403, raw: "<html>blocked</html>", headers: { "content-type": "text/html" } },
      ],
    });
    const { base, unknown } = harness(evri.http, fetchImpl, { [CODE]: URN });
    expect((await plugin.track(base, CONFIG, null, [CODE])).snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["status:9_NEW"]);
    await expect(plugin.track(base, CONFIG, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
