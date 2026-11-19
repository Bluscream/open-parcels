import { describe, expect, it } from "vitest";
import { pocztaPolska } from "../../src/carriers/poczta_polska/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { html, json, onPrefix, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "TE000000001PL";
const OTHER = "TE000000002PL";
const KEY = ["made", "up", "key"].join("-");
const PORTAL = `<div id="widgetTracking" data-urltracking="https://uss.poczta-polska.pl/uss/v2.0/tracking" data-apikey="${KEY}"></div>`;

const portal = () => onPrefix("GET emonitoring.poczta-polska.pl/", html(PORTAL));
const api = (...replies: Response[]) =>
  onPrefix("POST uss.poczta-polska.pl/uss/v2.0/tracking/checkmailex", ...replies);

function payload(latest: string, extra: Record<string, unknown> = {}) {
  return {
    number: CODE,
    mailStatus: 0,
    mailInfo: {
      weight: 1.25,
      finished: false,
      events: [
        { code: "P_NAD", name: "Nadanie", time: "2026-11-16T10:00:00" },
        { code: "P_WZL", name: "Wysłanie", time: "2026-11-17T08:00:00", canceled: true },
        { code: "P_PZL", name: "Przyjęcie", time: "2026-11-17T09:00:00" },
        {
          code: latest,
          name: "Najnowszy",
          time: "2026-11-18T08:30:00",
          postOffice: { name: "UP Testowo 1" },
        },
      ],
      ...extra,
    },
  };
}

describe("Poczta Polska tracking", () => {
  it("reads the widget key, maps the newest scan and keeps the history in local time", async () => {
    const world = new World(pocztaPolska, [portal(), api(json(payload("P_A")))]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "poczta_polska",
      barcode: CODE,
      status: "at_pickup_point",
      rawStatus: "Najnowszy",
      pickup: true,
      pickupPoint: "UP Testowo 1",
      weightKg: 1.25,
      delivered: false,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T07:30:00.000Z", "at_pickup_point"],
      ["2026-11-17T08:00:00.000Z", "in_transit"],
      ["2026-11-16T09:00:00.000Z", "in_transit"],
    ]);
    expect(world.calls[1]?.headers.get("api_key")).toBe(KEY);
  });

  it("reports a delivered parcel with its delivery time", async () => {
    const world = new World(pocztaPolska, [
      portal(),
      api(json(payload("P_D", { finished: true }))),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T07:30:00.000Z",
    });
  });

  it("treats the not-found marker and grouped consignments as not found", async () => {
    const grouped = payload("P_D", { components: [{ number: OTHER }] });
    const world = new World(pocztaPolska, [portal(), api(json({ mailStatus: -1 }), json(grouped))]);
    expect((await world.track([CODE, OTHER, "../x"])).snapshots).toEqual([]);
    expect(world.requests().filter((p) => p.startsWith("POST"))).toHaveLength(2);
  });

  it("reports an unknown scan code and keeps the status empty", async () => {
    const world = new World(pocztaPolska, [portal(), api(json(payload("P_SOMETHING_NEW")))]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:P_SOMETHING_NEW"]);
  });

  it("re-reads the key once on a 401 and gives up on the second", async () => {
    const world = new World(pocztaPolska, [
      onPrefix("GET emonitoring.poczta-polska.pl/", html(PORTAL), html(PORTAL)),
      api(json({}, 401), json({}, 401)),
    ]);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(TransientError);
    expect(world.requests().filter((p) => p.startsWith("GET"))).toHaveLength(2);
  });

  it("never sends the key to an endpoint the portal did not advertise as expected", async () => {
    const moved = PORTAL.replace("uss.poczta-polska.pl", "elsewhere.example");
    const world = new World(pocztaPolska, [
      onPrefix("GET emonitoring.poczta-polska.pl/", html(moved)),
    ]);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(world.calls).toHaveLength(1);
  });

  it("stops on a network error without retrying", async () => {
    const failing = new World(pocztaPolska, [
      portal(),
      onPrefix("POST uss", new TypeError("offline")),
    ]);
    await expect(failing.track([CODE, OTHER])).rejects.toBeInstanceOf(TransientError);
    expect(failing.requests().filter((p) => p.startsWith("POST"))).toHaveLength(1);
  });
});
