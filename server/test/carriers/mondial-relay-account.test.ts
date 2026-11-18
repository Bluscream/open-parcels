import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signatureHeaders } from "../../src/carriers/mondial_relay/account.js";
import { mondialRelay } from "../../src/carriers/mondial_relay/index.js";
import { carrierKey } from "../../src/plugin/rules.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, madeUp, on, onPrefix, World } from "./harness.js";

// Made-up shipments, devices and tokens only.
const TOKEN = "POST account.inpost-group.com/oauth2/token";
const RECEIVED = "GET mobile-app-bff.mondialrelay.app/api/parcels-list-received";
const SHIPPED = "GET mobile-app-bff.mondialrelay.app/api/parcels-list-shipped";
const SECRET = { refreshToken: madeUp("refresh"), deviceId: "device-1" };

describe("Mondial Relay account signature", () => {
  it("hashes the app value, nonce and stamp twice", () => {
    const headers = signatureHeaders(new Date("2026-11-18T12:00:00Z"), "nonce-1");
    const inner = createHash("sha256")
      .update(`${carrierKey("mondial_relay", "account_signing_value")}nonce-11795003200`)
      .digest("hex");
    expect(headers).toEqual({
      "X-MR-Param1": "nonce-1",
      "X-MR-Param2": "1795003200",
      "X-MR-API-KEY": createHash("sha256").update(inner).digest("hex"),
    });
  });
});

describe("Mondial Relay account", () => {
  it("reads both lists with a signed request, de-duplicated", async () => {
    const item = (uid: string, step: number) => ({
      expedition: {
        shipmentUid: uid,
        shipmentId: `0000${uid}`,
        stepSection: step,
        brandLabel: "Example Shop",
      },
    });
    const world = new World(mondialRelay, [
      on(
        TOKEN,
        json({ access_token: "a1", refresh_token: madeUp("refresh", "2"), expires_in: 900 }),
      ),
      onPrefix(RECEIVED, json({ list: [item("1", 1), item("1", 1)], totalPages: 1 })),
      onPrefix(SHIPPED, json({ list: [item("2", 3)], totalPages: 1 })),
    ]);
    const result = await world.fetchAccount({}, SECRET);
    const call = world.calls[1];
    expect(call?.headers.get("x-mr-api-key")).toMatch(/^[0-9a-f]{64}$/);
    expect(call?.headers.get("user-agent")).toBe(carrierKey("mondial_relay", "account_user_agent"));
    expect(call?.headers.get("device-uid")).toBe("device-1");
    expect(result.snapshots.map((parcel) => [parcel.status, parcel.direction])).toEqual([
      ["at_pickup_point", "incoming"],
      ["delivered", "outgoing"],
    ]);
    expect(world.saved[0]).toMatchObject({ refreshToken: madeUp("refresh", "2") });
  });

  it("treats a refused signature as transient and a refused grant as a sign-in problem", async () => {
    const world = new World(mondialRelay, [
      on(TOKEN, json({ access_token: "a1" }), json({ error: "invalid_grant" }, 400)),
      onPrefix(RECEIVED, json({}, 403)),
    ]);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(TransientError);
    world.stored = null;
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
  });
});
