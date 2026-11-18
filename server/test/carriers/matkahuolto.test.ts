import { describe, expect, it } from "vitest";
import { matkahuolto } from "../../src/carriers/matkahuolto/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, scripted, trackingContext, type Reply } from "./public-tracking-harness.js";

// Made-up codes and values only.
const CODE = "MH0000000001";
const plugin = register(matkahuolto);

function event(date: string, time: string, description: string, place = "Esimerkki") {
  return { date, time, description, place };
}

async function run(replies: Reply[], codes = [CODE]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknown } = trackingContext(matkahuolto.http, fetchImpl);
  const result = await plugin.track(base, {}, null, codes);
  return { result, calls, unknown };
}

describe("matkahuolto tracking", () => {
  it("reads a parcel waiting at a pickup point, with history and no window", async () => {
    const { result, calls, unknown } = await run([
      json({
        parcelNumber: CODE,
        trackingEvents: [
          event(
            "18.11.2026",
            "10:00",
            "The parcel is available for pickup at Example Shop, Example Street 1",
            "Example Shop, Example Street 1",
          ),
          event("17.11.2026", "09:30", "The consignment has been sorted."),
          event("16.11.2026", "08:00", "The consignment is being processed."),
        ],
      }),
    ]);
    expect(calls[0]?.url.searchParams.get("parcelNumber")).toBe(CODE);
    const parcel = result.snapshots[0];
    expect(parcel?.status).toBe("at_pickup_point");
    expect(parcel?.pickupPoint).toBe("Example Shop");
    expect(parcel?.rawStatus).toBe("Available for pickup");
    expect(parcel?.plannedFrom).toBeNull();
    expect(parcel?.url).toContain(CODE);
    // Helsinki is UTC+2 in November.
    expect(parcel?.history.map((entry) => [entry.at, entry.status, entry.rawStatus])).toEqual([
      ["2026-11-18T08:00:00.000Z", "at_pickup_point", "Available for pickup"],
      ["2026-11-17T07:30:00.000Z", "in_transit", "Sorted"],
      ["2026-11-16T06:00:00.000Z", "registered", "Being processed"],
    ]);
    expect(unknown).toEqual([]);
  });

  it("marks a delivered parcel with its delivery time", async () => {
    const { result } = await run([
      json({
        parcelNumber: CODE,
        trackingEvents: [event("18.11.2026", "12:00", "The consignment has been delivered.")],
      }),
    ]);
    expect(result.snapshots[0]?.delivered).toBe(true);
    expect(result.snapshots[0]?.deliveredAt).toBe("2026-11-18T10:00:00.000Z");
  });

  it("treats notFound as not found", async () => {
    const { result } = await run([json({ notFound: true })]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports an unknown sentence by hash, never by its text", async () => {
    const sentence = "Something new happened at Example Shop, Example Street 1";
    const { result, unknown } = await run([
      json({ parcelNumber: CODE, trackingEvents: [event("18.11.2026", "12:00", sentence)] }),
    ]);
    expect(result.snapshots[0]?.status).toBeNull();
    expect(result.snapshots[0]?.rawStatus).toBeNull();
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatch(/^description:[0-9a-f]{16}$/);
  });

  it("stops on an answer that is not tracking data", async () => {
    await expect(run([json({ other: 1 })])).rejects.toThrow(UnexpectedResponseError);
    await expect(run([{ status: 200, body: "<html>", type: "text/html" }])).rejects.toThrow(
      UnexpectedResponseError,
    );
    await expect(run([json({}, 502)])).rejects.toThrow(TransientError);
    await expect(run([new Error("offline")])).rejects.toThrow(TransientError);
  });
});
