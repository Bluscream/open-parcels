import { describe, expect, it } from "vitest";
import { postnord } from "../../src/carriers/postnord/index.js";
import { carrierKey } from "../../src/plugin/rules.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../src/plugin/errors.js";
import type { InteractiveSignIn } from "../../src/plugin/sign-in.js";
import { html, json, madeUp, on, World } from "./harness.js";

// Made-up shipment ids and tokens only.
const TOKEN = "POST account.postnord.com/oauth2/token";
const INBOX = "GET api2.postnord.com/rest/customer/v2/receiverapp/tracking";
const SECRET = { refreshToken: madeUp("refresh") };

describe("PostNord account", () => {
  it("reads both buckets with the app's gateway key and the direction", async () => {
    const world = new World(postnord, [
      on(TOKEN, json({ access_token: "a1", refresh_token: madeUp("refresh", "2") })),
      on(
        INBOX,
        json({
          activeShipments: [
            {
              shipmentId: "00000000000000000001",
              items: [{ status: "EN_ROUTE", statusText: { header: "On its way" } }],
            },
          ],
          archivedShipments: [
            {
              shipmentId: "00000000000000000002",
              status: "DELIVERED",
              userData: { direction: "OUTGOING" },
              items: [],
            },
          ],
        }),
      ),
    ]);
    const result = await world.fetchAccount({}, SECRET);
    expect(world.calls[1]?.url.searchParams.get("apikey")).toBe(
      carrierKey("postnord", "receiver_app_key"),
    );
    expect(world.calls[1]?.headers.get("context")).toBe("mobileapp");
    expect(
      result.snapshots.map((parcel) => [parcel.status, parcel.rawStatus, parcel.direction]),
    ).toEqual([
      ["in_transit", "On its way", "incoming"],
      ["delivered", "DELIVERED", "outgoing"],
    ]);
  });

  it("treats a refused fresh token as the app key's problem and a missing bucket as a change", async () => {
    const world = new World(postnord, [
      on(TOKEN, json({ access_token: "a1" }), json({ access_token: "a2" })),
      on(INBOX, json({}, 403), json({ activeShipments: [] })),
    ]);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(TransientError);
    // A token renewed for its age is not renewed again in the same run.
    expect(world.requests().filter((key) => key === TOKEN)).toHaveLength(1);
    world.stored = null;
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("never asks for a new sign-in on a WAF 403 or a 404 from the token endpoint", async () => {
    for (const status of [403, 404]) {
      const world = new World(postnord, [on(TOKEN, html("<html>blocked</html>", status))]);
      await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(TransientError);
    }
    const refused = new World(postnord, [on(TOKEN, json({ error: "invalid_grant" }, 400))]);
    await expect(refused.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("accepts the pasted app redirect with a Location label", async () => {
    const world = new World(postnord, [
      on(TOKEN, json({ access_token: "a1", refresh_token: madeUp("refresh", "3") })),
    ]);
    const flow = (postnord.signIn as readonly unknown[])[0] as InteractiveSignIn<
      object,
      typeof SECRET
    >;
    const context = {
      config: {},
      kind: "account" as const,
      http: world.base().http,
      clock: world.clock,
    };
    const started = await flow.start(context);
    const state = "state" in started ? started.state : null;
    const sent = (state as { state: string }).state;
    const done = await flow.continue(context, state, {
      pasted: `Location: com.postnord.app://redirect?code=c1&state=${sent}`,
    });
    expect(done).toEqual({ secret: { refreshToken: madeUp("refresh", "3") } });
  });
});
