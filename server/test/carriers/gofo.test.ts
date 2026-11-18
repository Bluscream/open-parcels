import { describe, expect, it } from "vitest";
import { gofo } from "../../src/carriers/gofo/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { keylessContext, scripted, type Reply } from "./keyless-harness.js";

// Made-up codes and values only.
const US_CODE = "GFUS00000000000001";
const IT_CODE = "GFIT00000000000002";
const plugin = register(gofo);

function item(code: string, latest: string, dates: [string, string]) {
  return {
    waybillNo: code,
    status: "Transit",
    weight: 0.5,
    trackEventList: [
      { processCode: latest, processContent: `Event ${latest}`, processDate: dates[0] },
      { processCode: "100", processContent: "Created", processDate: dates[1] },
    ],
  };
}

async function run(code: string, replies: Reply[]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknown } = keylessContext(gofo.http, fetchImpl);
  const result = await plugin.track(base, {}, null, [code]);
  return { result, calls, unknown };
}

describe("gofo", () => {
  it("reads a US parcel in Los Angeles wall-clock time", async () => {
    const body = {
      success: true,
      data: {
        success: [item(US_CODE, "208", ["2026-01-15T09:00:00-0700", "2026-01-14T09:00:00-0700"])],
      },
    };
    const { result, calls } = await run(US_CODE, [{ status: 200, body }]);
    expect(calls[0]?.url.pathname).toBe("/us/cnee-api/consignee/track/query");
    expect(calls[0]?.headers.get("user-time-zone")).toBe("America/Los_Angeles");
    const [parcel] = result.snapshots;
    expect(parcel?.status).toBe("out_for_delivery");
    expect(parcel?.weightKg).toBe(0.5);
    expect(parcel?.plannedFrom).toBeNull();
    expect(parcel?.plannedTo).toBeNull();
    // January: PST is UTC-8, not the stamped -07:00.
    expect(parcel?.history.map((e) => e.at)).toEqual([
      "2026-01-15T17:00:00.000Z",
      "2026-01-14T17:00:00.000Z",
    ]);
  });

  it("reads a delivered parcel on the European transport", async () => {
    const body = {
      code: 200,
      data: [item(IT_CODE, "205", ["2026-02-02T12:00:00+0100", "2026-02-01T08:00:00Z"])],
    };
    const { result, calls } = await run(IT_CODE, [{ status: 200, body }]);
    expect(calls[0]?.headers.get("lang")).toBe("it");
    expect(result.snapshots[0]?.delivered).toBe(true);
    expect(result.snapshots[0]?.deliveredAt).toBe("2026-02-02T11:00:00.000Z");
  });

  it("returns nothing for unknown codes on both transports", async () => {
    const a = await run(US_CODE, [
      { status: 200, body: { success: false, data: { success: [], error: { US: "x" } } } },
    ]);
    expect(a.result.snapshots).toEqual([]);
    const b = await run(IT_CODE, [{ status: 200, body: { code: 200, data: [] } }]);
    expect(b.result.snapshots).toEqual([]);
    const unroutable = await run("XX123", []);
    expect(unroutable.calls).toEqual([]);
  });

  it("reports an unmapped code and falls back to the item status", async () => {
    const body = {
      code: 200,
      data: [item(IT_CODE, "999", ["2026-02-02T12:00:00Z", "2026-02-01T08:00:00Z"])],
    };
    const { result, unknown } = await run(IT_CODE, [{ status: 200, body }]);
    expect(unknown).toEqual(["999"]);
    expect(result.snapshots[0]?.status).toBe("in_transit");
  });

  it("stops on unexpected answers and network errors", async () => {
    await expect(run(IT_CODE, [{ status: 200, body: { code: 500 } }])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(run(US_CODE, [{ status: 200, body: { success: false } }])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(run(IT_CODE, [{ status: 503, text: "" }])).rejects.toBeInstanceOf(TransientError);
    await expect(run(IT_CODE, [new Error("offline")])).rejects.toBeInstanceOf(TransientError);
  });
});
