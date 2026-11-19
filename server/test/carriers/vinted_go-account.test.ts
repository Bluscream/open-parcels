import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verificationToken } from "../../src/carriers/vinted_go/account.js";
import { vintedGo } from "../../src/carriers/vinted_go/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/api.js";
import { json, madeUp, on, World } from "./harness.js";
import { SignInDriver } from "./sign-in-driver.js";

// Made-up values only.
const HOST = "carrier.vintedgo.com/members";
const REGISTER = `POST ${HOST}/registrations`;
const CONFIRM = `POST ${HOST}/registrations/confirm`;
const REFRESH = `POST ${HOST}/sessions/refresh`;
const SHIPMENTS = `GET ${HOST}/shipments`;
const RT = madeUp("vinted", "refresh");
const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
const pair = (tag: string) =>
  json({ session_token: `st-${tag}`, refresh_token: madeUp("vinted", tag) });

describe("Vinted Go sign-in", () => {
  it("reads the token from a pasted link or takes it as is", () => {
    expect(verificationToken(" https://app.vintedgo.com/auth/verify?token=abc%2D1&x=2 ")).toBe(
      "abc-1",
    );
    expect(verificationToken("plain-token")).toBe("plain-token");
  });

  it("emails a link and trades the pasted link for a refresh token", async () => {
    const world = new World(vintedGo, [
      on(REGISTER, json({})),
      on(CONFIRM, json({ error: "invalid" }, 422), pair("one")),
    ]);
    const driver = new SignInDriver(world, "email_link", "account");
    expect(await driver.start()).toMatchObject({ kind: "form" });
    expect(await driver.continue({ email: "someone@example.invalid" })).toEqual({
      kind: "email_link",
      destination: "s***@example.invalid",
    });
    expect(JSON.parse(world.calls[0]?.body ?? "")).toEqual({ email: "someone@example.invalid" });
    await expect(
      driver.continue({ code: "https://app.vintedgo.com/auth/verify?token=old" }),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    // The refused link kept the step: the next paste goes to the same confirmation.
    expect(await driver.continue({ code: "https://app.vintedgo.com/auth/verify?token=t-2" })).toBe(
      null,
    );
    expect(driver.secret).toEqual({ refreshToken: madeUp("vinted", "one") });
    expect(JSON.parse(world.calls[2]?.body ?? "")).toEqual({ token: "t-2" });
  });

  it("treats an unreachable sign-in service as transient", async () => {
    const world = new World(vintedGo, [on(REGISTER, json({}, 502))]);
    const driver = new SignInDriver(world, "email_link", "account");
    await driver.start();
    await expect(driver.continue({ email: "someone@example.invalid" })).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});

describe("Vinted Go account", () => {
  const shipment = (code: string, extra: Record<string, unknown> = {}) => ({
    tracking_code: code,
    contact_type: "recipient",
    point: { name: "Example Locker" },
    resolved_pick_up_code: "PICK-UP-CODE",
    ...extra,
  });

  it("lists sent and received shipments, renewing a refused session once", async () => {
    const world = new World(vintedGo, [
      on(REFRESH, pair("b")),
      on(
        SHIPMENTS,
        json({}, 401),
        json([
          shipment("VG00000001"),
          shipment("VG00000002", { contact_type: "sender" }),
          shipment("VG00000003", {
            status_group: "completed",
            resolution: "delivered",
            shipment_state: "Delivered",
          }),
          shipment("VG00000004", { contact_type: "courier" }),
        ]),
      ),
      on(
        "GET carrier.vintedgo.com/members/public/v1/tracking_events/VG00000001",
        json({ tracking_events: [{ group: "ready_for_pickup", timestamp: 1763470800000 }] }),
      ),
      on(
        "GET carrier.vintedgo.com/members/public/v1/tracking_events/VG00000002",
        json({ tracking_events: [{ group: "shipped", timestamp: 1763470800000 }] }),
      ),
    ]);
    // A session from an earlier run, which Vinted Go has since refused.
    world.stored = { base: fingerprint(RT), refresh: RT, session: "st-old" };
    const result = await world.fetchAccount({}, { refreshToken: RT });
    expect(result.complete).toBe(false);
    expect(result.snapshots.map((s) => [s.barcode, s.direction, s.status])).toEqual([
      ["VG00000001", "incoming", "at_pickup_point"],
      ["VG00000002", "outgoing", "in_transit"],
      ["VG00000003", "incoming", "delivered"],
    ]);
    expect(result.snapshots[0]?.pickupPoint).toBe("Example Locker");
    expect(JSON.stringify(result.snapshots.map((s) => s.raw))).not.toContain("PICK-UP-CODE");
    expect(world.unknown).toEqual(["contact_type:courier"]);
    // The completed shipment needed no timeline call; the rotated refresh token was kept.
    expect(world.requests().filter((key) => key.includes("tracking_events"))).toHaveLength(2);
    expect(world.stored).toMatchObject({ refresh: madeUp("vinted", "b"), session: "st-b" });
  });

  it("does not renew a session it minted this run again after a 401", async () => {
    const world = new World(vintedGo, [
      on(REFRESH, pair("a"), pair("b")),
      on(SHIPMENTS, json({}, 401)),
    ]);
    await expect(world.fetchAccount({}, { refreshToken: RT })).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
    expect(world.requests().filter((key) => key === REFRESH)).toHaveLength(1);
  });

  it("asks for a new sign-in only when the refresh token is refused", async () => {
    const refused = new World(vintedGo, [on(REFRESH, json({}, 401))]);
    await expect(refused.fetchAccount({}, { refreshToken: RT })).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
    const down = new World(vintedGo, [on(REFRESH, new TypeError("offline"))]);
    await expect(down.fetchAccount({}, { refreshToken: RT })).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});
