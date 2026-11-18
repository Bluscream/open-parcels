import { describe, expect, it } from "vitest";
import { hermes } from "../../src/carriers/hermes/index.js";
import { register } from "../../src/engine/registry.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import type { FetchLike } from "../../src/plugin/http.js";
import { fakeContext, fakeNetwork, html, json } from "./harness.js";

// Made-up codes and values only.
const ACTIVE = "99000000000001";
const DELIVERED = "99000000000002";
const SHOP = "99000000000003";
const USERNAME = "test-user";
const credentials = { username: USERNAME, password: ["made", "up"].join("-") };

const plugin = register(hermes);

function event(parcelStatus: string, timestamp: string, historyText: string) {
  return { timestamp, status: "HAPPY", parcelStatus, historyText };
}

function trackingPayload(code: string, latest: string, extra: Record<string, unknown> = {}) {
  return {
    barcode: code,
    parcelProgress: [
      event(latest, "2026-11-18T08:00:00Z", "Neuester Schritt"),
      event("EDL_BOOKED_DROPOFF", "2026-11-17T16:00:00Z", "Wunschablageort gebucht"),
      event("SORTED", "2026-11-17T10:00:00Z", "Die Sendung wurde sortiert."),
      event("ANNOUNCED", "2026-11-16T10:00:00Z", "Die Sendung wurde angekündigt."),
    ],
    ...extra,
  };
}

function shipment(code: string, parcelStatus: string | null, delivered = false) {
  return {
    barcode: code,
    address: { addressType: "HOMEDELIVERY", firstName: "Testperson" },
    atg: { companyName: "Beispielshop" },
    metaInformation: { delivered },
    parcelHistory: [
      { status: "AVISE", statusHistoryText: "Angekündigt", timestamp: "2026-11-16T10:00:00Z" },
      {
        status: "UMSCHLAG_INLAND",
        statusHistoryText: "Sortiert",
        timestamp: "2026-11-17T10:00:00Z",
      },
    ],
    ...(parcelStatus === null
      ? {}
      : {
          status: {
            parcelStatus,
            deliveryTime: delivered ? "2026-11-18T09:00:00Z" : undefined,
            text: { shortText: "Kurztext" },
          },
        }),
  };
}

type Reply = { status: number; body: unknown; html?: boolean } | Error;

/** Routes requests by "METHOD path" to scripted replies; each route's replies are used in order. */
function fakeHermes(routes: Record<string, Reply[]>) {
  const calls: { key: string; auth: string | null; body: string | null }[] = [];
  const { fetchImpl } = fakeNetwork([
    (call) => {
      const key = `${call.method} ${call.url.pathname.replace(/^\/api\/v12\//, "")}`;
      calls.push({
        key,
        auth: call.headers.get("authorization"),
        body: typeof call.init.body === "string" ? call.init.body : null,
      });
      const reply = routes[key]?.shift() ?? { status: 404, body: [] };
      if (reply instanceof Error) {
        return reply;
      }
      return reply.html === true
        ? html("<html>blocked</html>", reply.status)
        : json(reply.body, reply.status);
    },
  ]);
  return { fetchImpl, calls };
}

function context(fetchImpl: FetchLike, session: unknown = null) {
  const { base, saved, unknownKeys } = fakeContext(hermes.http, fetchImpl, { session });
  return { base, saved, unknown: unknownKeys };
}

const search = (code: string) => `GET /tnt/v2/shipments/search/${code}`;
const tokens = (n: number) => ({ accessToken: `at-${n}`, refreshToken: `rt-${n}` });

describe("Hermes public tracking", () => {
  it("maps the newest code through the shared table and reads the forecast window", async () => {
    const { fetchImpl } = fakeHermes({
      [search(ACTIVE)]: [
        {
          status: 200,
          body: [
            trackingPayload(ACTIVE, "DELIVERY_TOUR_STARTED", {
              forecast: {
                deliveryTimeFromUTC: "2026-11-18T13:00:00Z",
                deliveryTimeToUTC: "2026-11-18T15:00:00Z",
              },
              atg: { companyName: "Beispielshop" },
            }),
          ],
        },
      ],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE]);
    const [parcel] = result.snapshots;
    expect(result.complete).toBe(true);
    expect(parcel).toMatchObject({
      carrier: "hermes",
      barcode: ACTIVE,
      status: "out_for_delivery",
      rawStatus: "Neuester Schritt",
      delivered: false,
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:00:00.000Z",
      sender: "Beispielshop",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      null,
      "in_transit",
      "registered",
    ]);
    expect(parcel?.url).toContain(ACTIVE);
  });

  it("treats 404, 400 and an empty list as not found and skips implausible codes", async () => {
    const { fetchImpl, calls } = fakeHermes({
      [search(ACTIVE)]: [{ status: 404, body: {} }],
      [search(DELIVERED)]: [{ status: 400, body: {} }],
      [search(SHOP)]: [{ status: 200, body: [] }],
    });
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, {}, null, [ACTIVE, DELIVERED, SHOP, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("keeps delivered right from the attribute block while a new code is unmapped", async () => {
    const { fetchImpl } = fakeHermes({
      [search(DELIVERED)]: [
        {
          status: 200,
          body: [
            trackingPayload(DELIVERED, "SOMETHING_NEW", {
              parcelAttributes: { delivered: true, deliveredTimestamp: "2026-11-18T08:00:00Z" },
            }),
          ],
        },
      ],
    });
    const { base, unknown } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [DELIVERED])).snapshots;
    expect(parcel).toMatchObject({
      status: null,
      delivered: true,
      deliveredAt: "2026-11-18T08:00:00.000Z",
    });
    expect(unknown).toEqual(["SOMETHING_NEW"]);
  });

  it("reports a parcel delivered to a PaketShop as waiting there", async () => {
    const { fetchImpl } = fakeHermes({
      [search(SHOP)]: [{ status: 200, body: [trackingPayload(SHOP, "DELIVERED_PARCELSHOP")] }],
    });
    const { base } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [SHOP])).snapshots;
    expect(parcel).toMatchObject({ status: "at_pickup_point", pickup: true, delivered: false });
  });

  it("fails the run on a 5xx instead of calling the code unknown", async () => {
    const { fetchImpl } = fakeHermes({ [search(ACTIVE)]: [{ status: 502, body: {} }] });
    const { base } = context(fetchImpl);
    await expect(plugin.track(base, {}, null, [ACTIVE])).rejects.toBeInstanceOf(TransientError);
  });
});

describe("Hermes account", () => {
  it("signs in once, stores the tokens and adds the public forecast", async () => {
    const { fetchImpl, calls } = fakeHermes({
      "POST users/login": [{ status: 200, body: tokens(1) }],
      "GET shipments": [
        {
          status: 200,
          body: [
            shipment(ACTIVE, "ZUSTELLTOUR"),
            shipment(DELIVERED, "ZUGESTELLT", true),
            { barcode: SHOP, shipmentType: "IN_UNKNOWN" },
            { shipmentType: "IN_UNKNOWN" },
          ],
        },
      ],
      [search(ACTIVE)]: [
        {
          status: 200,
          body: [
            trackingPayload(ACTIVE, "OUT_FOR_DELIVERY", {
              forecast: {
                deliveryTimeFromUTC: "2026-11-18T13:00:00Z",
                deliveryTimeToUTC: "2026-11-18T15:00:00Z",
              },
            }),
          ],
        },
      ],
    });
    const { base, saved } = context(fetchImpl);
    const result = await plugin.fetchAccount(base, {}, credentials);
    expect(saved).toEqual([tokens(1)]);
    expect(calls.find((c) => c.key === "GET shipments")?.auth).toBe("Bearer at-1");
    expect(result.complete).toBe(true);
    expect(result.snapshots.map((p) => [p.barcode, p.status, p.delivered])).toEqual([
      [ACTIVE, "out_for_delivery", false],
      [DELIVERED, "delivered", true],
      [SHOP, null, false],
    ]);
    expect(result.snapshots[0]).toMatchObject({
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:00:00.000Z",
      receiver: "Testperson",
      sender: "Beispielshop",
    });
    expect(result.snapshots[1]?.deliveredAt).toBe("2026-11-18T09:00:00.000Z");
    // Delivered parcels are never looked up for a forecast.
    expect(calls.some((c) => c.key === search(DELIVERED))).toBe(false);
  });

  it("never reports a parcel on a shop counter as delivered and names the shop", async () => {
    const raw = {
      ...shipment(ACTIVE, "ZUGESTELLT_PAKETSHOP", true),
      address: {
        addressType: "PARCELSHOP",
        lastName: "Kiosk Beispiel",
        street: "Musterweg 1",
        zipCode: "00000",
        city: "Musterstadt",
      },
    };
    const { fetchImpl } = fakeHermes({ "GET shipments": [{ status: 200, body: [raw] }] });
    const { base } = context(fetchImpl, tokens(1));
    const [parcel] = (await plugin.fetchAccount(base, { publicForecast: false }, credentials))
      .snapshots;
    expect(parcel).toMatchObject({
      status: "at_pickup_point",
      delivered: false,
      pickup: true,
      pickupPoint: "Kiosk Beispiel, Musterweg 1, 00000 Musterstadt",
    });
  });

  it("refreshes a refused token once, then retries the read", async () => {
    const { fetchImpl, calls } = fakeHermes({
      "GET shipments": [
        { status: 401, body: { error: "expired" } },
        { status: 200, body: [] },
      ],
      "POST users/refreshtoken": [{ status: 200, body: tokens(2) }],
    });
    const { base, saved } = context(fetchImpl, tokens(1));
    await plugin.fetchAccount(base, {}, credentials);
    expect(saved).toEqual([tokens(2)]);
    expect(calls.map((c) => c.key)).toEqual([
      "GET shipments",
      "POST users/refreshtoken",
      "GET shipments",
    ]);
    expect(calls.some((c) => c.key === "POST users/login")).toBe(false);
  });

  it("signs in with the stored credentials only when the refresh is refused too", async () => {
    const { fetchImpl, calls } = fakeHermes({
      "GET shipments": [
        { status: 401, body: {} },
        { status: 200, body: [] },
      ],
      "POST users/refreshtoken": [{ status: 401, body: {} }],
      "POST users/login": [{ status: 200, body: tokens(3) }],
    });
    const { base, saved } = context(fetchImpl, tokens(1));
    await plugin.fetchAccount(base, {}, credentials);
    expect(saved).toEqual([tokens(3)]);
    expect(calls.filter((c) => c.key === "POST users/login")).toHaveLength(1);
  });

  it("asks the user to sign in again when the credentials are refused", async () => {
    const { fetchImpl } = fakeHermes({ "POST users/login": [{ status: 401, body: {} }] });
    const { base } = context(fetchImpl);
    await expect(plugin.fetchAccount(base, {}, credentials)).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
  });

  it("does not loop when a renewed token is refused again", async () => {
    const { fetchImpl, calls } = fakeHermes({
      "GET shipments": [
        { status: 401, body: {} },
        { status: 401, body: {} },
      ],
      "POST users/refreshtoken": [{ status: 200, body: tokens(2) }],
    });
    const { base } = context(fetchImpl, tokens(1));
    await expect(plugin.fetchAccount(base, {}, credentials)).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
    expect(calls).toHaveLength(3);
  });

  it("never signs in again on a network error, a 5xx or a gateway HTML page", async () => {
    for (const reply of [
      new Error("ECONNRESET"),
      { status: 503, body: {} },
      { status: 403, body: null, html: true },
    ] satisfies Reply[]) {
      const { fetchImpl, calls } = fakeHermes({ "GET shipments": [reply] });
      const { base, saved } = context(fetchImpl, tokens(1));
      await expect(plugin.fetchAccount(base, {}, credentials)).rejects.toBeInstanceOf(
        TransientError,
      );
      expect(calls.map((c) => c.key)).toEqual(["GET shipments"]);
      expect(saved).toEqual([]);
    }
  });

  it("keeps the account result when forecasts fail and stops them on a rate limit", async () => {
    const many = [ACTIVE, DELIVERED, SHOP, "99000000000004", "99000000000005"];
    const { fetchImpl, calls } = fakeHermes({
      "GET shipments": [{ status: 200, body: many.map((code) => shipment(code, "UNTERWEGS")) }],
      [search(ACTIVE)]: [{ status: 429, body: {} }],
      [search(DELIVERED)]: [{ status: 502, body: {} }],
    });
    const { base } = context(fetchImpl, tokens(1));
    const result = await plugin.fetchAccount(base, {}, credentials);
    expect(result.snapshots).toHaveLength(5);
    expect(result.snapshots.every((p) => p.plannedFrom === null)).toBe(true);
    const lookups = calls.filter((c) => c.key.startsWith("GET /tnt/"));
    expect(lookups.length).toBeLessThan(many.length);
  });

  it("refuses to run without stored credentials", async () => {
    const { fetchImpl } = fakeHermes({});
    const { base } = context(fetchImpl);
    await expect(plugin.fetchAccount(base, {}, null)).rejects.toBeInstanceOf(SignInRejectedError);
  });
});
