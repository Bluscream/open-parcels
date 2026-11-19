import { describe, expect, it } from "vitest";
import { dhl } from "../../src/carriers/dhl/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/api.js";
import { json, madeUp, on, World } from "./harness.js";
import { SignInDriver } from "./sign-in-driver.js";

// Made-up values only: no real tracking numbers, names or addresses.
const LOGIN = "POST my.dhlecommerce.nl/api/user/login";
const PARCELS = "GET my.dhlecommerce.nl/receiver-parcel-api/parcels";
const SENT = "GET my.dhlecommerce.nl/api/orders/sentShipments";
const NL = { account: "nl" } as const;
const CREDENTIALS = { email: "someone@example.invalid", password: madeUp("dhl", "nl") };

function loggedIn(): Response {
  return json({ firstName: "Test" }, 200, { "set-cookie": "XSRF-TOKEN=xsrf-1; Path=/" });
}

function parcel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    barcode: "JVGL00000000000000000001",
    status: "IN_DELIVERY",
    category: "IN_DELIVERY",
    isReturn: false,
    sender: { name: "Example Shop" },
    receiver: { name: "Test Person", address: { postalCode: "1234 AB" } },
    destination: { locationType: "ADDRESS" },
    receivingTimeIndication: {
      indicationType: "IntervalIndication",
      start: "2026-11-18T13:00:00Z",
      end: "2026-11-18T15:00:00Z",
    },
    ...overrides,
  };
}

describe("DHL Netherlands sign-in", () => {
  it("is the account flow for NL sources only", () => {
    const world = new World(dhl);
    const ids = (config: unknown) =>
      world.plugin.signInFlows("account", config).map((flow) => flow.id);
    expect(ids({})).toEqual(["de_account"]);
    expect(ids(NL)).toEqual(["nl_account"]);
    expect(world.plugin.signInFlows("tracking", NL).map((flow) => flow.type)).toEqual(["api_key"]);
  });

  it("asks for email and password, and stores them once DHL accepts them", async () => {
    const world = new World(dhl, [on(LOGIN, json({}, 401), loggedIn())]);
    const driver = new SignInDriver(world, "nl_account", "account", NL);
    expect(await driver.start()).toMatchObject({ kind: "form" });
    expect(world.calls).toEqual([]);
    await expect(driver.continue(CREDENTIALS)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(await driver.continue(CREDENTIALS)).toBeNull();
    expect(driver.secret).toEqual({ nl: CREDENTIALS });
    expect(JSON.parse(world.calls[1]?.body ?? "{}")).toEqual(CREDENTIALS);
  });

  it("reports an outage as transient, never as a refusal", async () => {
    const world = new World(dhl, [on(LOGIN, json({}, 503))]);
    const driver = new SignInDriver(world, "nl_account", "account", NL);
    await driver.start();
    await expect(driver.continue(CREDENTIALS)).rejects.toBeInstanceOf(TransientError);
  });
});

describe("DHL Netherlands account", () => {
  it("lists received, returned and sent parcels, signing in again once on 401", async () => {
    const world = new World(dhl, [
      on(
        PARCELS,
        json({}, 401),
        json({
          parcels: [
            parcel(),
            parcel({
              barcode: "JVGL00000000000000000002",
              isReturn: true,
              status: "DELIVERED_AT_SHIPPER",
              category: "DELIVERED",
            }),
          ],
        }),
      ),
      on(LOGIN, loggedIn()),
      on(
        SENT,
        json([
          { ...parcel({ barcode: "JVGL00000000000000000003" }), type: "outgoing" },
          { ...parcel({ barcode: "JVGL00000000000000000004" }), type: "incoming" },
        ]),
      ),
    ]);
    const result = await world.fetchAccount(NL, { nl: CREDENTIALS });
    expect(result.complete).toBe(true);
    const [incoming, returned, sent] = result.snapshots;
    expect(result.snapshots).toHaveLength(3);
    expect(incoming).toMatchObject({
      barcode: "JVGL00000000000000000001",
      direction: "incoming",
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:00:00.000Z",
      sender: "Example Shop",
      url: "https://my.dhlecommerce.nl/portal/tracktrace/JVGL00000000000000000001/1234AB",
    });
    expect(returned).toMatchObject({ direction: "outgoing", status: "delivered", delivered: true });
    expect(sent).toMatchObject({ barcode: "JVGL00000000000000000003", direction: "outgoing" });
    const parcelsCall = world.calls.filter((call) => call.key === PARCELS)[1];
    expect(parcelsCall?.headers.get("x-xsrf-token")).toBe("xsrf-1");
  });

  it("signs in again at most once per run, not once per list", async () => {
    const world = new World(dhl, [
      on(PARCELS, json({}, 401), json({ parcels: [] })),
      on(LOGIN, loggedIn(), loggedIn()),
      on(SENT, json({}, 401)),
    ]);
    await expect(world.fetchAccount(NL, { nl: CREDENTIALS })).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
    expect(world.calls.filter((call) => call.key === LOGIN)).toHaveLength(1);
  });

  it("needs the Dutch sign-in data", async () => {
    const world = new World(dhl);
    await expect(world.fetchAccount(NL, { refreshToken: "x" })).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
  });

  it("does not sign in again after a network error", async () => {
    const world = new World(dhl, [on(PARCELS, new TypeError("network down"))]);
    await expect(world.fetchAccount(NL, { nl: CREDENTIALS })).rejects.toBeInstanceOf(
      TransientError,
    );
    expect(world.requests()).not.toContain(LOGIN);
  });
});
