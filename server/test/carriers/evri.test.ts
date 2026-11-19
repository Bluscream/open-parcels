import { describe, expect, it } from "vitest";
import { evri } from "../../src/carriers/evri/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, json, raw, routeTable } from "./harness.js";

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
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [REFERENCE]: [json({ parcelIdentifiers: [{ urn: URN }] }, 200)],
          [DETAIL]: [
            json(
              parcel(
                stage("2", "2026-11-17T10:00:00Z"),
                stage("4_COURIER", "2026-11-18T07:00:00Z"),
              ),
              200,
            ),
          ],
        },
        "host",
      ),
    ]);
    const { base, saved, unknown } = fakeContext(evri.http, fetchImpl);
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

  it("never takes a single result that names neither the barcode nor its id", async () => {
    const other = parcel(stage("2", "2026-11-17T10:00:00Z"));
    const stranger = {
      results: [{ ...other.results[0], parcelIdentifiers: [{ value: "EV00000000000099" }] }],
    };
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [REFERENCE]: [json({ parcelIdentifiers: [{ urn: URN }] }, 200)],
          [DETAIL]: [json(stranger, 200)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(evri.http, fetchImpl);
    await expect(plugin.track(base, CONFIG, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });

  it("uses a remembered id without resolving again and dates the delivery", async () => {
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [DETAIL]: [json(parcel(stage("5_SHOP", "2026-11-18T12:00:00Z")), 200)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(evri.http, fetchImpl, { session: { [CODE]: URN } });
    const [found] = (await plugin.track(base, CONFIG, null, [CODE])).snapshots;
    expect(calls).toHaveLength(1);
    expect(found).toMatchObject({ status: "delivered", deliveredAt: "2026-11-18T12:00:00.000Z" });
  });

  it("treats an invalid reference as not found", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [REFERENCE]: [json({ errors: [{ message: "Invalid reference: x" }] }, 400)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(evri.http, fetchImpl);
    expect((await plugin.track(base, CONFIG, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown stage and treats a refused website key as transient", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [DETAIL]: [
            json(parcel(stage("9_NEW", "2026-11-18T12:00:00Z")), 200),
            raw("<html>blocked</html>", 403, { "content-type": "text/html" }),
          ],
        },
        "host",
      ),
    ]);
    const { base, unknown } = fakeContext(evri.http, fetchImpl, { session: { [CODE]: URN } });
    expect((await plugin.track(base, CONFIG, null, [CODE])).snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["status:9_NEW"]);
    await expect(plugin.track(base, CONFIG, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
