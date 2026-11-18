import { describe, expect, it } from "vitest";
import { genikiTaxydromiki } from "../../src/carriers/geniki_taxydromiki/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, inOrder, json, raw, type Answer } from "./harness.js";

/** Replies in order; once they run out, 500 with an empty body. */
const scripted = (replies: Answer[]) => fakeNetwork([inOrder(...replies)], () => raw("", 500));

// Made-up codes and values only.
const CODE = "ZZ00000001";
const plugin = register(genikiTaxydromiki);

function scan(StatusCode: string, StatusDate: string, Status = `Scan ${StatusCode}`) {
  return { Status, StatusCode, StatusDate, Shop: "TEST HUB" };
}

function found(scans: unknown[], extra: Record<string, unknown> = {}): Answer {
  return json(
    {
      success: true,
      [CODE]: {
        TrackAndTraceResult: { Result: 0, Checkpoints: { Checkpoint: scans }, ...extra },
      },
    },
    200,
  );
}

async function run(replies: Answer[]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknownKeys: unknown } = fakeContext(genikiTaxydromiki.http, fetchImpl);
  const result = await plugin.track(base, {}, null, [CODE]);
  return { result, calls, unknown };
}

describe("geniki taxydromiki", () => {
  it("reads a parcel out for delivery with history in Greek time", async () => {
    const { result, calls } = await run([
      found([
        scan("C_A3", "2026-07-02T08:30:00", "On delivery"),
        scan("C_NW", "2026-07-01T10:00:00"),
        scan("C_KK", "2026-07-01T18:00:00"),
      ]),
    ]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe(JSON.stringify({ lang: "en", voucherNo: CODE }));
    const [parcel] = result.snapshots;
    expect(parcel?.status).toBe("out_for_delivery");
    expect(parcel?.rawStatus).toBe("On delivery");
    expect(parcel?.plannedFrom).toBeNull();
    expect(parcel?.plannedTo).toBeNull();
    expect(parcel?.history.map((e) => e.at)).toEqual([
      "2026-07-02T05:30:00.000Z",
      "2026-07-01T15:00:00.000Z",
      "2026-07-01T07:00:00.000Z",
    ]);
    expect(parcel?.history[0]?.location).toBe("TEST HUB");
  });

  it("marks a delivery with the header delivery date and the receiver", async () => {
    const { result } = await run([
      found([scan("C_NW", "2026-01-10T09:00:00"), scan("C_W2", "2026-01-11T12:00:00")], {
        Status: "DELIVERED",
        DeliveryDate: "2026-01-11T12:05:00",
        Consignee: "TEST PERSON",
      }),
    ]);
    const [parcel] = result.snapshots;
    expect(parcel?.delivered).toBe(true);
    expect(parcel?.deliveredAt).toBe("2026-01-11T10:05:00.000Z");
    expect(parcel?.receiver).toBe("TEST PERSON");
  });

  it("ignores a scan withdrawn by its cancelling partner", async () => {
    const { result, unknown } = await run([
      found([
        scan("C_NW", "2026-01-10T09:00:00"),
        scan("C_L1", "2026-01-10T10:00:00"),
        scan("C_L2", "2026-01-10T11:00:00"),
      ]),
    ]);
    expect(result.snapshots[0]?.status).toBe("registered");
    expect(unknown).toEqual([]);
  });

  it("returns nothing for an unknown code or a code without scans", async () => {
    const unknownCode = await run([
      json({ success: true, [CODE]: { TrackAndTraceResult: { Result: 9 } } }, 200),
    ]);
    expect(unknownCode.result.snapshots).toEqual([]);
    const noScans = await run([found([])]);
    expect(noScans.result.snapshots).toEqual([]);
  });

  it("reports an unmapped code and keeps the last mapped status", async () => {
    const { result, unknown } = await run([
      found([scan("C_NW", "2026-01-10T09:00:00"), scan("C_ZZ", "2026-01-10T10:00:00")]),
    ]);
    expect(unknown).toEqual(["C_ZZ"]);
    expect(result.snapshots[0]?.status).toBe("registered");
    expect(result.snapshots[0]?.history[0]?.status).toBeNull();
  });

  it("stops on a wrong envelope and on HTTP errors", async () => {
    await expect(run([json({ success: false }, 200)])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(run([raw("<html>", 200)])).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(run([raw("", 502)])).rejects.toBeInstanceOf(TransientError);
    await expect(run([new Error("offline")])).rejects.toBeInstanceOf(TransientError);
  });
});
