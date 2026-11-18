import { describe, expect, it } from "vitest";
import { ukrposhta } from "../../src/carriers/ukrposhta/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeFetch } from "./fake-carrier.js";

// Made-up values only.
const CODE = "0599999999901";
const STATUSES = "GET www.ukrposhta.ua/status-tracking/0.0.1/statuses";
const plugin = register(ukrposhta);

const event = (code: string, date: string, eventName: string) => ({
  barcode: CODE,
  event: code,
  eventName,
  date,
});

describe("Ukrposhta tracking", () => {
  it("reads the final event, Kyiv time and the history newest first", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [STATUSES]: [
        {
          status: 200,
          body: [
            event("10100", "2026-11-15T09:00:00", "Registered"),
            event("20700", "2026-11-16T10:30:00", "Departed"),
            event("21400", "2026-11-18T12:00:00", "Arrived at the post office"),
          ],
        },
      ],
    });
    const { base, unknown } = fakeContext(ukrposhta.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      carrier: "ukrposhta",
      barcode: CODE,
      status: "at_pickup_point",
      rawStatus: "21400 Arrived at the post office",
      pickup: true,
      delivered: false,
      // The carrier gives no delivery window.
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.history[0]).toMatchObject({
      at: "2026-11-18T10:00:00.000Z",
      status: "at_pickup_point",
    });
    expect(parcel?.history.map((entry) => entry.status)).toEqual([
      "at_pickup_point",
      "in_transit",
      "registered",
    ]);
    expect(calls[0]?.url.searchParams.get("barcode")).toBe(CODE);
    expect(unknown).toEqual([]);
  });

  it("marks everything after a refusal as returning, even reused delivered codes", async () => {
    const { fetchImpl } = fakeFetch({
      [STATUSES]: [
        {
          status: 200,
          body: [
            event("10100", "2026-11-10T09:00:00", "Registered"),
            event("31200", "2026-11-12T09:00:00", "Refused by the addressee"),
            event("41000", "2026-11-14T09:00:00", "Return: delivered to the sender"),
          ],
        },
      ],
    });
    const { base } = fakeContext(ukrposhta.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({ status: "returning", delivered: false });
  });

  it("reads a delivery with its time", async () => {
    const { fetchImpl } = fakeFetch({
      [STATUSES]: [{ status: 200, body: [event("41000", "2026-07-01T15:00:00", "Delivered")] }],
    });
    const { base } = fakeContext(ukrposhta.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      delivered: true,
      deliveredAt: "2026-07-01T12:00:00.000Z",
    });
  });

  it("treats an empty list as not found", async () => {
    const { fetchImpl } = fakeFetch({ [STATUSES]: [{ status: 200, body: [] }] });
    const { base } = fakeContext(ukrposhta.http, fetchImpl);
    expect(await plugin.track(base, {}, null, [CODE])).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unknown final code and falls back to the last mapped event", async () => {
    const { fetchImpl } = fakeFetch({
      [STATUSES]: [
        {
          status: 200,
          body: [
            event("20700", "2026-11-16T10:30:00", "Departed"),
            event("99999", "2026-11-17T10:30:00", "Something new"),
          ],
        },
      ],
    });
    const { base, unknown } = fakeContext(ukrposhta.http, fetchImpl);
    const result = await plugin.track(base, {}, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      status: "in_transit",
      rawStatus: "99999 Something new",
    });
    expect(unknown).toEqual(["99999"]);
  });

  it("stops on a refused bearer, a changed body or a network error", async () => {
    const { fetchImpl } = fakeFetch({
      [STATUSES]: [
        { status: 401, raw: "" },
        { status: 200, body: { error: "x" } },
        new Error("offline"),
      ],
    });
    const { base } = fakeContext(ukrposhta.http, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
