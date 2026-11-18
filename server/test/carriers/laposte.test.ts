import { describe, expect, it } from "vitest";
import { laposte } from "../../src/carriers/laposte/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { keylessContext, scripted, type Reply } from "./keyless-harness-2.js";

// Made-up codes and values only.
const CODE = "ZZ000000001FR";
const plugin = register(laposte);

function found(shipment: Record<string, unknown>): Reply {
  return { status: 200, body: [{ returnCode: 200, shipment }] };
}

const chronopost = (codes: string[]) => ({
  idShip: "OTHER-ID",
  product: "chronopost",
  event: codes.map((code, i) => ({
    code,
    label: `Event ${code}`,
    date: `2026-05-0${String(codes.length - i)}T10:00:00+02:00`,
  })),
});

async function run(replies: Reply[]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknown } = keylessContext(laposte.http, fetchImpl);
  const result = await plugin.track(base, {}, null, [CODE]);
  return { result, calls, unknown };
}

describe("laposte", () => {
  it("reads a Chronopost parcel with history", async () => {
    const { result, calls } = await run([found(chronopost(["MD1", "PC1"]))]);
    expect(calls[0]?.url.pathname).toBe(`/ssu/sun/back/suivi-unifie/${CODE}`);
    expect(calls[0]?.headers.get("user-agent")).toBe("PostmanRuntime/7.49.1");
    const [parcel] = result.snapshots;
    expect(parcel?.barcode).toBe(CODE);
    expect(parcel?.status).toBe("out_for_delivery");
    expect(parcel?.plannedFrom).toBeNull();
    expect(parcel?.plannedTo).toBeNull();
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-05-02T08:00:00.000Z", "out_for_delivery"],
      ["2026-05-01T08:00:00.000Z", "in_transit"],
    ]);
  });

  it("keeps a Chronopost return current until a final delivery", async () => {
    const { result } = await run([found(chronopost(["ET1", "RE1", "PC1"]))]);
    expect(result.snapshots[0]?.status).toBe("returning");
  });

  it("reads a delivered Colissimo parcel by its current state", async () => {
    const { result } = await run([
      found({
        product: "colissimo",
        currentState: { code: "DESLIVD", shortLabel: "Livré" },
        deliveryDate: "2026-05-03T12:00:00+02:00",
        contextData: { merchantName: "Test Shop" },
        event: [{ group: "DESLIVD", label: "Delivered", date: "2026-05-03T12:00:00+02:00" }],
      }),
    ]);
    const [parcel] = result.snapshots;
    expect(parcel?.delivered).toBe(true);
    expect(parcel?.deliveredAt).toBe("2026-05-03T10:00:00.000Z");
    expect(parcel?.rawStatus).toBe("Livré");
    expect(parcel?.sender).toBe("Test Shop");
  });

  it("returns nothing for an unknown code", async () => {
    const { result } = await run([{ status: 200, body: [{ returnCode: 104 }] }]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports an unmapped code", async () => {
    const { result, unknown } = await run([found(chronopost(["ZZ9", "PC1"]))]);
    expect(unknown).toEqual(["ZZ9"]);
    expect(result.snapshots[0]?.status).toBeNull();
  });

  it("stops on unexpected answers and network errors", async () => {
    await expect(run([{ status: 200, body: {} }])).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(run([{ status: 200, body: [{ returnCode: 200 }] }])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(run([{ status: 500, text: "" }])).rejects.toBeInstanceOf(TransientError);
    await expect(run([new Error("offline")])).rejects.toBeInstanceOf(TransientError);
  });
});
