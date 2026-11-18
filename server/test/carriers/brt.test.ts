import { describe, expect, it } from "vitest";
import { brt } from "../../src/carriers/brt/index.js";
import { SignInRejectedError } from "../../src/plugin/errors.js";
import { json, madeUp, on, onPrefix, World } from "./harness.js";

// Made-up parcel numbers, tokens and accounts only.
const SECRET = { username: "user@example.com", password: madeUp("pass") };
const LOGIN = "POST login.dpdgroup.com/auth/realms/login/protocol/openid-connect/token";
const GUEST = "POST www.dpdgroup.com/concept/webservice/oauth/token";
const SSO = "POST www.dpdgroup.com/concept/webservice/users/login/consignee-sso";
const LIST = "POST www.dpdgroup.com/concept/webservice/v7/parcels";
const DETAIL = "POST www.dpdgroup.com/concept/webservice/v10/parcels/details/";

const shipment = {
  parcelNumber: "0000000000001",
  senderName: "Example Shop",
  status: { description: "PARCEL_OUT_FOR_DELIVERY", eventDateAndTimeZoneId: "Europe/Rome" },
  deliveryDate: "2026-11-18",
  deliveryTimeFrom: "10:00:00",
  deliveryTimeTo: "12:00:00",
};

describe("BRT account", () => {
  it("signs in through the group login, lists the parcels and reads their details", async () => {
    const world = new World(brt, [
      on(LOGIN, json({ access_token: "kc" })),
      on(GUEST, json({ access_token: "app" })),
      on(SSO, json({ access_token: "user" })),
      on(LIST, json({ incomingShipments: [shipment], sendingShipments: [] })),
      onPrefix(
        DETAIL,
        json({
          receiver: { name: "Test Person" },
          weight: 1.2,
          parcelEvents: [
            { date: "2026-11-18", time: "07:00:00", eventType: "DLO", eventTypeText: "Out" },
          ],
        }),
      ),
    ]);
    const [parcel] = (await world.fetchAccount({}, SECRET)).snapshots;
    expect(world.calls[2]?.body).toBe("kc");
    expect(world.calls[2]?.headers.get("authorization")).toBe("Bearer app");
    expect(world.calls[3]?.url.searchParams.get("bu")).toBe("BRT");
    expect(parcel).toMatchObject({
      carrier: "brt",
      status: "out_for_delivery",
      plannedFrom: "2026-11-18T09:00:00.000Z",
      plannedTo: "2026-11-18T11:00:00.000Z",
      receiver: "Test Person",
      weightKg: 1.2,
      history: [{ status: "out_for_delivery" }],
    });
    expect(world.stored).toEqual({ token: "user" });
  });

  it("reuses the stored token and reports a wrong password", async () => {
    const world = new World(brt, [
      on(LIST, json({}, 401)),
      on(LOGIN, json({ error: "invalid_grant" }, 401)),
    ]);
    world.stored = { token: "old" };
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(world.requests()).toEqual([LIST, LOGIN]);
  });

  it("never signs in again on a network error", async () => {
    const world = new World(brt, [on(LIST, new TypeError("fetch failed"))]);
    world.stored = { token: "old" };
    await expect(world.fetchAccount({}, SECRET)).rejects.toThrow();
    expect(world.requests()).toEqual([LIST]);
  });
});
