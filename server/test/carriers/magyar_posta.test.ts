import { describe, expect, it } from "vitest";
import { magyarPosta } from "../../src/carriers/magyar_posta/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, scripted, trackingContext, type Reply } from "./public-tracking-harness.js";

// Made-up codes and values only.
const CODE = "ZZ000000001HU";
const plugin = register(magyarPosta);

function row(category: string, detail: string, description: string, epoch: number | null) {
  return {
    tranzakcioKategoriaKod: category,
    tranzakcioAzon: detail,
    tranzakcioTipusLeirasSimple: description,
    tranzakcioValodiDatum: "20261117",
    tranzakcioValodiIdopont: "10:00:00",
    ...(epoch === null ? {} : { time: epoch }),
    postaNev: "Példa Posta|Példaváros",
    suly: "1500",
  };
}

async function run(replies: Reply[], codes = [CODE]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknown } = trackingContext(magyarPosta.http, fetchImpl);
  const result = await plugin.track(base, {}, null, codes);
  return { result, calls, unknown };
}

describe("magyar_posta tracking", () => {
  it("reads a parcel waiting at a post office, with history and weight", async () => {
    const { result, calls, unknown } = await run([
      json({
        [CODE]: [
          row("4", "KLHKT", "Átvehető", Date.parse("2026-11-18T08:00:00Z")),
          row("2", "X1", "Feldolgozva", null),
          row("1", "X0", "Felvéve", Date.parse("2026-11-16T09:00:00Z")),
        ],
      }),
    ]);
    expect(calls[0]?.url.searchParams.get("ragszam")).toBe(CODE);
    const parcel = result.snapshots[0];
    expect(parcel?.status).toBe("at_pickup_point");
    expect(parcel?.pickup).toBe(true);
    expect(parcel?.pickupPoint).toBe("Példa Posta");
    expect(parcel?.weightKg).toBe(1.5);
    // The carrier never gives a delivery window.
    expect(parcel?.plannedFrom).toBeNull();
    expect(parcel?.plannedTo).toBeNull();
    // The middle row has no epoch; its local Budapest time (UTC+1 in November) is used.
    expect(parcel?.history.map((event) => [event.at, event.status])).toEqual([
      ["2026-11-18T08:00:00.000Z", "at_pickup_point"],
      ["2026-11-17T09:00:00.000Z", "in_transit"],
      ["2026-11-16T09:00:00.000Z", "registered"],
    ]);
    expect(unknown).toEqual([]);
  });

  it("collapses the doubled handover and marks the parcel delivered", async () => {
    const at = Date.parse("2026-11-18T12:00:00Z");
    const { result } = await run([
      json({
        [CODE]: [row("5", "A", "Kézbesítve", at), row("5", "B", "Kézbesítve (rendszer)", at)],
      }),
    ]);
    expect(result.snapshots[0]?.delivered).toBe(true);
    expect(result.snapshots[0]?.deliveredAt).toBe("2026-11-18T12:00:00.000Z");
    expect(result.snapshots[0]?.history).toHaveLength(1);
  });

  it("treats a null or empty answer as not found", async () => {
    const { result } = await run([json({ [CODE]: null }), json({ [CODE]: [] })], [CODE, CODE]);
    expect(result.snapshots).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("reports unknown categories and falls back to the newest row that maps", async () => {
    const { result, unknown } = await run([
      json({ [CODE]: [row("9", "Q", "Új lépés", 2), row("2", "X", "Úton", 1)] }),
    ]);
    expect(result.snapshots[0]?.status).toBe("in_transit");
    expect(result.snapshots[0]?.rawStatus).toBe("Új lépés");
    expect(unknown).toContain("category:9");
  });

  it("reports an unknown delivery detail while keeping the courier reading", async () => {
    const { result, unknown } = await run([
      json({ [CODE]: [row("4", "NEWCODE", "Kiszállítás", 1)] }),
    ]);
    expect(result.snapshots[0]?.status).toBe("out_for_delivery");
    expect(unknown).toEqual(["delivery_detail:NEWCODE"]);
  });

  it("stops on an answer that is not tracking data", async () => {
    await expect(run([{ status: 200, body: "<html></html>", type: "text/html" }])).rejects.toThrow(
      UnexpectedResponseError,
    );
    await expect(run([json({ [CODE]: "x" })])).rejects.toThrow(UnexpectedResponseError);
    await expect(run([json({}, 500)])).rejects.toThrow(TransientError);
    await expect(run([new Error("offline")])).rejects.toThrow(TransientError);
  });
});
