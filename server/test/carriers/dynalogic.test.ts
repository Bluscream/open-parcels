import { describe, expect, it } from "vitest";
import { dynalogic } from "../../src/carriers/dynalogic/index.js";
import { InvalidSourceConfigError, register } from "../../src/engine/registry.js";
import { harness, scripted } from "./kit-harness.js";

// Made-up order numbers, postcodes and values only.
const CODE = "990000001";
const ROUTE = `GET api.dynagroup.nl/track-middleware/v1/transportorder/full/ordernumber/${CODE}/zipcode/9999zz`;
const CONFIG = { postalCode: "9999 zz" };
const plugin = register(dynalogic);

function order(scenario: string, step: number, code: number) {
  return {
    TrackAndTraceNumber: CODE,
    Scenario: scenario,
    ActiveStep: step,
    TransportResultCode: code,
    OrderData: {
      CustomerName: "Example Shop",
      Addressee: { Name1: "Test Person", City: "Voorbeeldstad" },
      Activities: [
        { ExecutedDateTime: "20261117100000", Description: "Order ontvangen" },
        { ExecutedDateTime: "20261118093000", Description: "Afgeleverd" },
      ],
    },
  };
}

describe("Dynalogic tracking", () => {
  it("derives the status from scenario, step and result and reads the activities", async () => {
    const { fetchImpl, calls } = scripted({
      [ROUTE]: [{ status: 200, body: order("DEL_DEF", 4, 0) }],
    });
    const { base, unknown } = harness(dynalogic.http, fetchImpl);
    const [found] = (await plugin.track(base, CONFIG, null, [CODE])).snapshots;
    expect(calls).toHaveLength(1);
    expect(found).toMatchObject({
      carrier: "dynalogic",
      barcode: CODE,
      status: "delivered",
      rawStatus: "DEL_DEF/4/0",
      deliveredAt: "2026-11-18T08:30:00.000Z",
      plannedFrom: null,
      plannedTo: null,
      sender: "Example Shop",
      receiver: "Test Person",
    });
    expect(found?.history).toEqual([
      { at: "2026-11-18T08:30:00.000Z", status: null, rawStatus: "Afgeleverd", location: null },
      {
        at: "2026-11-17T09:00:00.000Z",
        status: null,
        rawStatus: "Order ontvangen",
        location: null,
      },
    ]);
    expect(unknown).toEqual([]);
  });

  it("maps a failed scenario to a problem and an early step to registered", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [
        { status: 200, body: order("DEL_FAIL", 3, 9) },
        { status: 200, body: order("DEL_DEF", 1, 1) },
      ],
    });
    const { base } = harness(dynalogic.http, fetchImpl);
    expect((await plugin.track(base, CONFIG, null, [CODE])).snapshots[0]?.status).toBe("problem");
    expect((await plugin.track(base, CONFIG, null, [CODE])).snapshots[0]?.status).toBe(
      "registered",
    );
  });

  it("treats 404 as not found", async () => {
    const { fetchImpl } = scripted({ [ROUTE]: [{ status: 404, body: {} }] });
    const { base } = harness(dynalogic.http, fetchImpl);
    expect((await plugin.track(base, CONFIG, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown scenario and result code", async () => {
    const { fetchImpl } = scripted({ [ROUTE]: [{ status: 200, body: order("XX_NEW", 2, 999) }] });
    const { base, unknown } = harness(dynalogic.http, fetchImpl);
    const [found] = (await plugin.track(base, CONFIG, null, [CODE])).snapshots;
    expect(found?.status).toBe("in_transit");
    expect(unknown).toEqual(["status:scenario:XX_NEW", "status:result:999"]);
  });

  it("refuses a source without a valid postcode", async () => {
    const { fetchImpl } = scripted({});
    const { base } = harness(dynalogic.http, fetchImpl);
    await expect(plugin.track(base, { postalCode: "x" }, null, [CODE])).rejects.toBeInstanceOf(
      InvalidSourceConfigError,
    );
  });
});
