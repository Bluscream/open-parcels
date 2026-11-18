import { describe, expect, it } from "vitest";
import { pplCz } from "../../src/carriers/ppl_cz/index.js";
import { SignInRejectedError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import type { InteractiveSignIn } from "../../src/plugin/sign-in.js";
import { formOf, json, madeUp, on, onPrefix, World } from "./harness.js";

// Made-up shipment numbers, accounts, PINs and tokens only.
const CODE = "40000000001";
const TRACK = `POST api.dhl.com/ecs/ppl/webapi/TrackAndTrace/${CODE}`;
const TOKEN =
  "POST pplczmobidentity.b2clogin.com/PPLCZMobIdentity.onmicrosoft.com/B2C_1A_ROPC_AUTH/oauth2/v2.0/token";
const LIST = "GET api.dhl.com/ecs/ppl/mobapp/api/v2/me/shipments";
const SECRET = { email: "user@example.com", password: madeUp("minted") };

describe("PPL CZ tracking", () => {
  it("sends the empty body with the website key and falls back to the base code", async () => {
    const world = new World(pplCz, [
      on(
        TRACK,
        json({
          phase: "Delivered.SomeNewPlace",
          lastEventDate: "2026-11-18T10:00:00",
          addresses: [
            { type: 4, name: "Example Shop" },
            { type: 1, name: "Test Person" },
          ],
          events: [{ code: "OutForDelivery", eventDate: "2026-11-18T07:00:00" }],
        }),
        json({ detail: "service.TrackAndTrace.ShipmentNotFound" }, 400),
        json({ detail: "something.else" }, 400),
      ),
    ]);
    const [found] = (await world.track([CODE])).snapshots;
    expect(world.calls[0]?.body).toBe("{}");
    expect(world.calls[0]?.headers.get("dhl-api-key")).not.toBeNull();
    expect(found).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T09:00:00.000Z",
      sender: "Example Shop",
      history: [{ status: "out_for_delivery" }],
    });
    expect(JSON.stringify(found?.raw)).not.toContain("Test Person");
    expect((await world.track([CODE])).snapshots).toEqual([]);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});

describe("PPL CZ account", () => {
  it("runs the password grant, lists the shipments and reads their events", async () => {
    const world = new World(pplCz, [
      on(TOKEN, json({ access_token: "a1", expires_in: 3600 })),
      on(
        LIST,
        json({
          items: [
            { id: "s1", number: CODE, lastShipmentEvent: "DELIVERING", sender: "Example Shop" },
          ],
        }),
      ),
      onPrefix(
        "GET api.dhl.com/ecs/ppl/mobapp/api/v1/me/shipments/s1/events",
        json([{ event: "IN_TRANSPORT", createdAt: "2026-11-17T08:00:00Z", message: "On the way" }]),
      ),
    ]);
    const result = await world.fetchAccount({}, SECRET);
    expect(formOf(world.calls[0]).get("grant_type")).toBe("password");
    expect(result.snapshots[0]).toMatchObject({
      status: "out_for_delivery",
      direction: "incoming",
      sender: "Example Shop",
      history: [{ status: "in_transit" }],
    });
    expect(world.stored).toMatchObject({ access: "a1" });
  });

  it("asks for a new sign-in only when the stored password is refused", async () => {
    const world = new World(pplCz, [on(TOKEN, json({ error: "invalid_grant" }, 400))]);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    const outage = new World(pplCz, [on(TOKEN, json({ error: "server_error" }, 400))]);
    await expect(outage.fetchAccount({}, SECRET)).rejects.not.toBeInstanceOf(SignInRejectedError);
  });

  it("signs in with an e-mailed PIN", async () => {
    const world = new World(pplCz, [
      on(
        "POST api.dhl.com/ecs/ppl/mobapp/api/v1/registrations",
        new Response(null, { status: 204 }),
      ),
      onPrefix(
        "PUT api.dhl.com/ecs/ppl/mobapp/api/v1/registrations/",
        json({ password: madeUp("minted") }),
      ),
      on(TOKEN, json({ access_token: "a1" })),
    ]);
    const flow = (pplCz.signIn as readonly unknown[])[0] as InteractiveSignIn<
      object,
      typeof SECRET
    >;
    const context = {
      config: {},
      kind: "account" as const,
      http: world.base().http,
      clock: world.clock,
    };
    const first = await flow.start(context);
    const state1 = "state" in first ? first.state : null;
    const second = await flow.continue(context, state1, { email: "user@example.com" });
    expect("step" in second && second.step.kind).toBe("otp_code");
    const state2 = "state" in second ? second.state : null;
    expect(await flow.continue(context, state2, { code: "123456" })).toEqual({ secret: SECRET });
  });
});
