import { describe, expect, it } from "vitest";
import { purolator } from "../../src/carriers/purolator/index.js";
import { CaptchaError } from "../../src/plugin/errors.js";
import { zonedIso } from "../../src/plugin/kit/time.js";
import { json, on, raw, World } from "./harness.js";

// Made-up tracking numbers only. Expected times follow the runtime's own zone data.
const CODE = "335000000001";
const DATA = "POST public-tracking.purolator.com/tracking/data";

const found = (events: unknown[], packageStatus = "SDR") => ({
  searchResult: [{ status: "FOUND", shipmentIndex: 0, packageIndex: 0 }],
  trackingNumber: CODE,
  shipment: [
    {
      pieceTotalCount: 1,
      details: { weight: { value: 2, unit: "LB" } },
      package: [
        {
          status: { code: packageStatus },
          estimatedDeliveryDate: "2026-11-19",
          events,
        },
      ],
    },
  ],
});

describe("Purolator tracking", () => {
  it("reads the newest event in the scan's own zone and sends the website key", async () => {
    const world = new World(purolator, [
      on(
        DATA,
        json(
          found([
            {
              code: "4200",
              description: "On vehicle for delivery",
              dateTime: "2026-11-18 08:00:00",
              location: { provinceState: "MB" },
            },
            { code: "3000", description: "Label created", dateTime: "2026-11-17 10:00:00" },
          ]),
        ),
      ),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(world.calls[0]?.headers.get("x-api-key")).not.toBeNull();
    expect(parcel).toMatchObject({
      status: "out_for_delivery",
      rawStatus: "On vehicle for delivery",
      plannedFrom: zonedIso({ year: 2026, month: 11, day: 19 }, "America/Winnipeg"),
      weightKg: 0.907,
    });
    expect(parcel?.history[0]?.at).toBe(
      zonedIso({ year: 2026, month: 11, day: 18, hour: 8 }, "America/Winnipeg"),
    );
  });

  it("trusts the package's DEL status, treats NOT FOUND as absent and stops on a challenge", async () => {
    const world = new World(purolator, [
      on(
        DATA,
        json(found([{ code: "9999", dateTime: "2026-11-18 12:00:00" }], "DEL")),
        json({ searchResult: [{ status: "NOT FOUND" }] }),
        raw("", 202, { "x-amzn-waf-action": "challenge" }),
      ),
    ]);
    expect((await world.track([CODE])).snapshots[0]?.status).toBe("delivered");
    expect((await world.track([CODE])).snapshots).toEqual([]);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(CaptchaError);
  });
});
