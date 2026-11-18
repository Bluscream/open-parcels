import { describe, expect, it } from "vitest";
import { fanCourier } from "../../src/carriers/fan-courier/index.js";
import { register } from "../../src/engine/registry.js";
import { harness, scripted } from "./kit-harness-3.js";

// Made-up AWBs and values only.
const CODE = "9900000000001";
const ROUTE = "POST www.fancourier.ro/limit-tracking.php";
const plugin = register(fanCourier);

const event = (id: string, date: string, name: string, location = "Depozit A") => ({
  id,
  date,
  name,
  location,
});

function awb(...events: ReturnType<typeof event>[]) {
  return [{ awbNumber: CODE, weight: 2, confirmation: { name: "Test Person" }, events }];
}

describe("FAN Courier tracking", () => {
  it("maps the newest code, reads Romanian local times and the weight", async () => {
    const { fetchImpl, calls } = scripted({
      [ROUTE]: [
        {
          status: 200,
          body: awb(
            event("C0", "2026-11-17 09:00:00", "Expeditie preluata"),
            event("S1", "2026-11-18 08:00:00", "In livrare"),
          ),
        },
      ],
    });
    const { base, unknown } = harness(fanCourier.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(new URLSearchParams(calls[0]?.body ?? "").get("awb")).toBe(CODE);
    expect(found).toMatchObject({
      carrier: "fan-courier",
      status: "out_for_delivery",
      rawStatus: "In livrare",
      weightKg: 2,
      plannedFrom: null,
    });
    expect(found?.history[0]).toEqual({
      at: "2026-11-18T06:00:00.000Z",
      status: "out_for_delivery",
      rawStatus: "In livrare",
      location: "Depozit A",
    });
    expect(unknown).toEqual([]);
  });

  it("recognises a locker and a delivery", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [
        {
          status: 200,
          body: awb(event("H99", "2026-11-18 08:00:00", "Disponibil in FANbox", "Box 1")),
        },
        { status: 200, body: awb(event("S2", "2026-11-18 12:00:00", "Livrat")) },
      ],
    });
    const { base } = harness(fanCourier.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots[0]).toMatchObject({
      status: "at_pickup_point",
      pickupPoint: "Box 1",
    });
    expect((await plugin.track(base, {}, null, [CODE])).snapshots[0]).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T10:00:00.000Z",
    });
  });

  it("treats an error answer as not found", async () => {
    const { fetchImpl } = scripted({ [ROUTE]: [{ status: 200, body: { error: "AWB invalid" } }] });
    const { base } = harness(fanCourier.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown code", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [{ status: 200, body: awb(event("X9", "2026-11-18 08:00:00", "Ceva nou")) }],
    });
    const { base, unknown } = harness(fanCourier.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["status_code:X9"]);
  });
});
