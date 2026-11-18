import { describe, expect, it } from "vitest";
import { airmee } from "../../src/carriers/airmee/index.js";
import { RateLimitedError, SignInRejectedError, TransientError } from "../../src/plugin/api.js";
import { json, madeUp, on, World } from "./harness.js";
import { SignInDriver } from "./sign-in-driver.js";

// Made-up values only: the phone number is from no real numbering plan.
const API = "api.airmee.com/customer";
const SEND = `POST ${API}/register/sendOtp`;
const VERIFY = `POST ${API}/register/verifyOtp`;
const REFRESH = `POST ${API}/register/refreshToken`;
const ACTIVE = `GET ${API}/deliveries`;
const DONE = `GET ${API}/deliveries/completed`;
const PHONE = { country_code: "+46", phone_number: "0000000001" };
const tokens = (tag: string) =>
  json({ access_token: madeUp("at", tag), refresh_token: madeUp("rt", tag) });
const SIGNED_IN = { accessToken: madeUp("at", "0"), refreshToken: madeUp("rt", "0") };

describe("Airmee sign-in", () => {
  it("texts a code and trades it for the token pair; a wrong code can be retried", async () => {
    const world = new World(airmee, [
      on(SEND, json({ temp_token: "tmp-1", otp_hash_code: "hash-1" })),
      on(VERIFY, json({ message: "wrong code" }, 400), tokens("1")),
    ]);
    const driver = new SignInDriver(world, "sms_code", "account");
    expect(await driver.start()).toMatchObject({ kind: "form" });
    expect(await driver.continue(PHONE)).toEqual({
      kind: "otp_code",
      channel: "sms",
      destination: "…01",
    });
    expect(world.calls[0]?.headers.get("authorization")).toBe("TEMP_TOKEN");
    await expect(driver.continue({ code: "000000" })).rejects.toBeInstanceOf(SignInRejectedError);
    expect(await driver.continue({ code: " 123456 " })).toBeNull();
    expect(driver.secret).toEqual({
      accessToken: madeUp("at", "1"),
      refreshToken: madeUp("rt", "1"),
    });
    const verify = world.calls[2];
    expect(verify?.headers.get("authorization")).toBe("tmp-1");
    expect(JSON.parse(verify?.body ?? "")).toEqual({
      ...PHONE,
      otp_code: "123456",
      otp_hash_code: "hash-1",
    });
  });

  it("passes a rate limit on as such, not as a refused number", async () => {
    const world = new World(airmee, [on(SEND, json({}, 429, { "retry-after": "30" }))]);
    const driver = new SignInDriver(world, "sms_code", "account");
    await driver.start();
    await expect(driver.continue(PHONE)).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("Airmee account", () => {
  const order = (id: string, status: string) => ({
    id,
    sender_name: "Example Shop",
    new_timeline: [{ courier_status: status, time_of_event: 1763470800 }],
  });

  it("lists active and completed deliveries once each, renewing the token once", async () => {
    const world = new World(airmee, [
      on(ACTIVE, json({}, 401), json([order("o-1", "ON_WAY_TO_DROPOFF")])),
      on(REFRESH, tokens("2")),
      on(DONE, json([order("o-1", "ON_WAY_TO_DROPOFF"), order("o-2", "DROPOFF_CONFIRMED")])),
    ]);
    const result = await world.fetchAccount({}, SIGNED_IN);
    expect(result.snapshots.map((s) => [s.barcode, s.status, s.url])).toEqual([
      ["o-1", "out_for_delivery", null],
      ["o-2", "delivered", null],
    ]);
    expect(world.calls[0]?.headers.get("authorization")).toBe(madeUp("at", "0"));
    expect(world.calls[2]?.headers.get("authorization")).toBe(madeUp("at", "2"));
    expect(world.stored).toMatchObject({ refreshToken: madeUp("rt", "2") });
  });

  it("asks for a new sign-in only when the refresh is refused", async () => {
    const refused = new World(airmee, [on(ACTIVE, json({}, 401)), on(REFRESH, json({}, 401))]);
    await expect(refused.fetchAccount({}, SIGNED_IN)).rejects.toBeInstanceOf(SignInRejectedError);
    const down = new World(airmee, [on(ACTIVE, json({}, 401)), on(REFRESH, json({}, 502))]);
    await expect(down.fetchAccount({}, SIGNED_IN)).rejects.toBeInstanceOf(TransientError);
  });

  it("keeps tracking sources on the phone number hash", async () => {
    const world = new World(airmee);
    await expect(world.fetchAccount({}, {})).rejects.toBeInstanceOf(SignInRejectedError);
    await expect(world.track(["abcdefgh"], {}, {})).rejects.toBeInstanceOf(SignInRejectedError);
  });
});
