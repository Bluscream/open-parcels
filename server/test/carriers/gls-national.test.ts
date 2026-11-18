import { describe, expect, it } from "vitest";
import { requestStamp, signRequest } from "../../src/carriers/gls/es.js";
import { gls } from "../../src/carriers/gls/index.js";
import { CaptchaError, TransientError } from "../../src/plugin/errors.js";
import { json, on, raw, World } from "./harness.js";

// Made-up parcel numbers, postcodes and names only.
const CODE = "12345678901234";

describe("GLS Spain and Portugal", () => {
  it("signs method, route and stamp with HMAC-SHA256", () => {
    const stamp = requestStamp(new Date("2026-01-01T00:00:00.000Z"));
    expect(stamp).toBe("2026-01-01T00:00:00.000Z");
    expect(signRequest("k", "POST", "/expeditions/find", stamp)).toMatch(/^[0-9a-f]{64}$/);
    expect(signRequest("k", "POST", "/expeditions/find", stamp)).not.toBe(
      signRequest("k", "POST", "/api/v5/expeditions/find", stamp),
    );
  });

  it("looks a parcel up with a fresh signature and reads an incidence by its sentence", async () => {
    const world = new World(gls, [
      on(
        "POST api.consignee.gls-spain.es/api/v5/expeditions/find",
        json({
          found: {
            state: { code: "incidence", description: "Shipment redirected to GLS Point Test" },
            sender: { name: "Example Shop" },
            attributes: { weight: "1,5" },
            tracking: [
              { code: "onTransit", description: "In transit", at: "2026-11-17T10:00:00Z" },
              { code: "onTransit", description: "In transit", at: "2026-11-17T10:00:00Z" },
            ],
          },
        }),
      ),
    ]);
    const [found] = (await world.track([CODE], { country: "ES", postalCode: "28001" })).snapshots;
    const call = world.calls[0];
    expect(call?.headers.get("x-signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(call?.headers.get("x-timestamp")).toBe("2026-11-18T12:00:00.000Z");
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({
      find: { reference: CODE, destination: { address: { postalCode: "28001" } } },
    });
    expect(found).toMatchObject({
      barcode: CODE,
      status: "in_transit",
      sender: "Example Shop",
      weightKg: 1.5,
      url: `https://mygls.gls-spain.es/e/${CODE}/28001/es`,
    });
    expect(found?.history).toHaveLength(1);
  });

  it("treats the carrier's notFound as absent and a refused signature as transient", async () => {
    const world = new World(gls, [
      on(
        "POST api.consignee.gls-spain.es/api/v5/expeditions/find",
        json({ error: { details: "notFound" } }, 404),
        json({ error: { name: "ForbiddenError" } }, 403),
      ),
    ]);
    const config = { country: "PT", postalCode: "1000-001" };
    expect((await world.track([CODE], config)).snapshots).toEqual([]);
    await expect(world.track([CODE], config)).rejects.toBeInstanceOf(TransientError);
  });
});

describe("GLS Poland, US and Canada", () => {
  it("reads the Polish national route by number alone", async () => {
    const world = new World(gls, [
      on(
        `GET mygls.gls-poland.com.pl/api/v1/mygls-tracking/public/tracking/shipment/track/${CODE}`,
        json({
          parcelNumber: `${CODE}5`,
          progressBarIdent: "DELIVERED",
          stateDate: "2026-11-18T09:00:00+01:00",
          eventReasons: [
            {
              packageStatusName: "Doręczona",
              packageStatusDescription: "Paczka doręczona",
              packageStatusDate: "2026-11-18T09:00:00+01:00",
            },
            {
              packageStatusName: "W drodze",
              packageStatusDate: "2026-11-17T09:00:00+01:00",
            },
          ],
        }),
        json({ code: "mygls-tracking-400(111)" }, 400),
      ),
    ]);
    const config = { country: "PL", postalCode: "00-001" };
    const [found] = (await world.track([CODE], config)).snapshots;
    expect(found).toMatchObject({
      barcode: `${CODE}5`,
      status: "delivered",
      deliveredAt: "2026-11-18T08:00:00.000Z",
      rawStatus: "Paczka doręczona",
    });
    expect(found?.history.map((event) => event.status)).toEqual(["delivered", "in_transit"]);
    expect((await world.track([CODE], config)).snapshots).toEqual([]);
  });

  it("picks the newest of several US records and derives an unknown status", async () => {
    const shipment = (status: string, at: string, deliveryDate: string | null) => ({
      trackingNumber: CODE,
      status,
      deliveryDate,
      shipDate: "0001-01-01T00:00:00",
      transitDetails: [{ eventDateTime: at, eventDetails: status }],
    });
    const world = new World(gls, [
      on(
        "POST connect.gls-us.com/api/public/tracking/TrackShipmentSummariesByTrackingNumbers",
        json({
          shipments: [
            shipment("RETURNED TO SHIPPER", "2026-11-10T10:00:00", null),
            shipment("SOMETHING NEW", "2026-11-17T10:00:00", "2026-11-17T15:00:00"),
          ],
        }),
      ),
    ]);
    const [found] = (await world.track([CODE], { country: "US", postalCode: "90210" })).snapshots;
    expect(found).toMatchObject({ status: "delivered", deliveredAt: "2026-11-17T15:00:00.000Z" });
    expect(world.unknownKeys).toContain("SOMETHING NEW");
  });

  it("falls back to the number-only Canadian route and reads NORECORD as absent", async () => {
    const world = new World(gls, [
      on(`GET web.gls-canada.com/api/tracking/K1A0B1/${CODE}`, raw("", 404)),
      on(
        `GET web.gls-canada.com/api/tracking/${CODE}`,
        json({
          shipments: [
            {
              trackingNumber: CODE,
              currentStatus: { name: "Delivered", date: "2026-11-18 10:00:00" },
              sender: { city: "Testville", provinceCode: "ON" },
              parcels: [
                { activities: [{ status: "Pickup", activityDate: "2026-11-16 08:00:00" }] },
              ],
            },
          ],
        }),
      ),
    ]);
    const [found] = (await world.track([CODE], { country: "CA", postalCode: "K1A 0B1" })).snapshots;
    expect(found).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T10:00:00.000Z",
      sender: "Testville, ON",
    });
    expect(found?.history[0]?.status).toBe("in_transit");
  });
});

describe("GLS Germany", () => {
  const REGISTER = "POST api-backend.glsnxt.com/ecosystem/user-service/v1/users/register";
  const VALIDATE = "POST api-backend.glsnxt.com/ecosystem/user-service/v1/users/validate";
  const ADD = "POST gls-pakete-de-backend-app.ooh.glsnxt.com/api/v1/trackings";
  const config = { country: "DE", postalCode: "12345" };
  const token = (value: string) => ({ accessToken: value, expiresAt: 1_800_000_000 });
  const detail = {
    trackingReference: CODE,
    parcelNumber: "99999999999",
    latestStatusText: "Das Paket wird voraussichtlich im Laufe des Tages zugestellt.",
    deliveryEvents: [{ occurrenceDateTime: "2026-11-18 07:00:00", description: "Unterwegs" }],
  };

  it("registers a guest instance, adds the parcel and reads it by number afterwards", async () => {
    const world = new World(gls, [
      on(REGISTER, json(token("t1"), 201)),
      on(ADD, json(detail)),
      on("GET gls-pakete-de-backend-app.ooh.glsnxt.com/api/v1/trackings/99999999999", json(detail)),
    ]);
    const [found] = (await world.track([CODE], config)).snapshots;
    expect(found).toMatchObject({ status: "out_for_delivery", barcode: CODE });
    expect(world.calls[0]?.headers.get("authorization")).toBeNull();
    expect(world.calls[1]?.headers.get("authorization")).toBe("Bearer t1");
    expect(world.stored).toMatchObject({ de: { token: "t1", parcels: { [CODE]: "99999999999" } } });
    await world.track([CODE], config);
    expect(world.requests().at(-1)).toContain("/trackings/99999999999");
  });

  it("renews a refused token once and registers anew when the instance is gone", async () => {
    const world = new World(gls, [
      on(ADD, json({}, 401), json(detail)),
      on(VALIDATE, json({}, 404)),
      on(REGISTER, json(token("t2"), 201)),
    ]);
    world.stored = {
      de: { instanceId: "inst-1", token: "old", expiresAt: 1_900_000_000_000, parcels: {} },
    };
    const [found] = (await world.track([CODE], config)).snapshots;
    expect(found?.status).toBe("out_for_delivery");
    expect(world.requests()).toEqual([ADD, VALIDATE, REGISTER, ADD]);
  });

  it("never registers on a network error and stops on a captcha", async () => {
    const offline = new World(gls, [on(REGISTER, new TypeError("fetch failed"))]);
    await expect(offline.track([CODE], config)).rejects.toThrow();
    expect(offline.requests()).toEqual([REGISTER]);
    const guarded = new World(gls, [on(REGISTER, raw("please solve the reCAPTCHA", 403))]);
    await expect(guarded.track([CODE], config)).rejects.toBeInstanceOf(CaptchaError);
  });
});
