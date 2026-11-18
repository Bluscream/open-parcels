import { describe, expect, it } from "vitest";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../src/plugin/api.js";
import { header, json, track, World } from "./dhl-harness.js";

// Made-up codes in the shapes DHL uses; none belongs to a real parcel.
const CODE_A = "3SXYZ0000000001";
const CODE_B = "JJD000000000000000000001";

function gatewayElement(barcode: string, last: Record<string, unknown>, deliveredAt?: string) {
  return {
    barcode,
    events: [
      {
        category: "DATA_RECEIVED",
        status: "PRENOTIFICATION_RECEIVED",
        timestamp: "2026-11-10T06:31:07Z",
      },
      { timestamp: "2026-11-12T09:28:29Z", ...last },
    ],
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
  };
}

function gateway(world: World, body: unknown, status = 200) {
  world.routes.push((url) =>
    url.hostname === "api-gw.dhlparcel.nl"
      ? typeof body === "string"
        ? new Response(body, { status })
        : json(body, status)
      : undefined,
  );
}

describe("DHL tracking", () => {
  it("asks the gateway once for a batch and matches answers on the barcode", async () => {
    const world = new World();
    gateway(world, [
      gatewayElement(CODE_B, {
        category: "IN_DELIVERY",
        status: "OUT_FOR_DELIVERY",
        momentIndication: "2026-11-12T13:00:00+01:00",
      }),
    ]);
    const result = await track(world.context(null), [CODE_A, CODE_B.toLowerCase()]);

    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]?.url.searchParams.get("key")).toBe(`${CODE_A},${CODE_B}`);
    expect(result.complete).toBe(true);
    expect(result.snapshots).toHaveLength(1);
    const parcel = result.snapshots[0];
    expect(parcel?.barcode).toBe(CODE_B.toLowerCase());
    expect(parcel?.status).toBe("out_for_delivery");
    expect(parcel?.plannedFrom).toBe("2026-11-12T12:00:00.000Z");
    expect(parcel?.history.map((e) => e.status)).toEqual(["registered", "out_for_delivery"]);
  });

  it("lets the fine status win over the category and recognises pickup and returns", async () => {
    const world = new World();
    gateway(world, [
      gatewayElement(CODE_A, { category: "DELIVERED", status: "DELIVERED_AT_PARCELSTATION" }),
      gatewayElement(
        CODE_B,
        { category: "DELIVERED", status: "DELIVERED_AT_SHIPPER" },
        "2026-11-12T09:28:29Z",
      ),
    ]);
    const { snapshots } = await track(world.context(null), [CODE_A, CODE_B]);
    expect(snapshots[0]).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      delivered: false,
    });
    expect(snapshots[1]).toMatchObject({
      status: "returning",
      delivered: false,
      deliveredAt: null,
    });
  });

  it("falls back to the category and reports a status it does not know", async () => {
    const world = new World();
    gateway(world, [gatewayElement(CODE_A, { category: "UNDERWAY", status: "SOMETHING_NEW" })]);
    const { snapshots } = await track(world.context(null), [CODE_A]);
    expect(snapshots[0]?.status).toBe("in_transit");
    // The core warns once per value, so repeats are harmless.
    expect(new Set(world.unknown)).toEqual(new Set(["gateway_status:SOMETHING_NEW"]));

    const other = new World();
    gateway(other, [gatewayElement(CODE_A, { category: "ODD", status: "ALSO_ODD" })]);
    const second = await track(other.context(null), [CODE_A]);
    expect(second.snapshots[0]?.status).toBeNull();
    expect(new Set(other.unknown)).toEqual(
      new Set(["gateway_status:ALSO_ODD", "gateway_category:ODD"]),
    );
  });

  it("treats a 404 as not found and anything odd as a failed run", async () => {
    const notFound = new World();
    gateway(notFound, "Not found", 404);
    expect((await track(notFound.context(null), [CODE_A])).snapshots).toEqual([]);

    const odd = new World();
    gateway(odd, { not: "a list" });
    await expect(track(odd.context(null), [CODE_A])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );

    const down = new World();
    gateway(down, "oops", 502);
    await expect(track(down.context(null), [CODE_A])).rejects.toBeInstanceOf(TransientError);
  });

  it("merges the official API's answer when a key is set, newest scan first", async () => {
    const world = new World();
    gateway(world, [
      gatewayElement(CODE_A, { category: "UNDERWAY", status: "PARCEL_SORTED_AT_HUB" }),
    ]);
    world.routes.push((url) =>
      url.hostname === "api-eu.dhl.com"
        ? json({
            shipments: [
              {
                id: CODE_A,
                status: {
                  statusCode: "delivered",
                  status: "DELIVERED",
                  timestamp: "2026-11-13T10:00:00+01:00",
                },
                details: { weight: { value: 1500, unitText: "g" } },
                events: [
                  {
                    timestamp: "2026-11-13T10:00:00+01:00",
                    statusCode: "delivered",
                    status: "DELIVERED",
                  },
                  {
                    timestamp: "2026-11-12T09:28:29Z",
                    statusCode: "transit",
                    status: "PARCEL_SORTED_AT_HUB",
                  },
                ],
              },
            ],
          })
        : undefined,
    );
    const { snapshots } = await track(world.context({ apiKey: "made-up-key" }), [CODE_A]);

    expect(header(world.calls[1], "dhl-api-key")).toBe("made-up-key");
    const parcel = snapshots[0];
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-13T09:00:00.000Z",
      weightKg: 1.5,
    });
    // The shared scan appears once; both answers are kept in raw.
    expect(parcel?.history.map((e) => e.rawStatus)).toEqual([
      "PRENOTIFICATION_RECEIVED",
      "PARCEL_SORTED_AT_HUB",
      "DELIVERED",
    ]);
    expect(Object.keys(parcel?.raw as object)).toEqual(["gateway", "unified"]);
  });

  it("asks for a new key only when DHL refuses it, never on a network error", async () => {
    const refused = new World();
    gateway(refused, "Not found", 404);
    refused.routes.push((url) => (url.hostname === "api-eu.dhl.com" ? json({}, 401) : undefined));
    await expect(
      track(refused.context({ apiKey: "made-up-key" }), [CODE_A]),
    ).rejects.toBeInstanceOf(SignInRejectedError);

    const offline = new World();
    offline.routes.push(() => {
      throw new Error("ECONNRESET");
    });
    const error: unknown = await track(offline.context({ apiKey: "made-up-key" }), [CODE_A]).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(SignInRejectedError);
  });

  it("paces requests to each host conservatively", async () => {
    const world = new World();
    gateway(world, "Not found", 404);
    world.routes.push((url) => (url.hostname === "api-eu.dhl.com" ? json({}, 404) : undefined));
    const start = world.clock.now().getTime();
    await track(world.context({ apiKey: "made-up-key" }), [CODE_A, CODE_B]);
    expect(world.hosts()).toEqual([
      "GET api-gw.dhlparcel.nl/track-trace",
      "GET api-eu.dhl.com/track/shipments",
      "GET api-eu.dhl.com/track/shipments",
    ]);
    expect(world.clock.now().getTime() - start).toBeGreaterThanOrEqual(6_000);
  });
});
