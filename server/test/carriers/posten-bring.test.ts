import { describe, expect, it } from "vitest";
import { postenBring } from "../../src/carriers/posten_bring/index.js";
import type { InteractiveSignIn } from "../../src/plugin/sign-in.js";
import { SignInRejectedError } from "../../src/plugin/errors.js";
import { formOf, json, madeUp, on, World } from "./harness.js";

// Made-up parcel numbers and tokens only.
const TOKEN = "POST login.bring.com/api/oauth/accesstoken";
const INBOX = "POST api.posten.no/parcel-api/v1/parcel";
const CONFIG = { brand: "bring" };
const SECRET = { refreshToken: madeUp("refresh", "0") };

const parcel = (number: string, status: string, events: unknown[] = []) => ({
  parcelNumber: number,
  status,
  direction: "receive",
  sender: { name: "Example Shop" },
  weightInKg: 0.5,
  events,
});

describe("Posten / Bring account", () => {
  it("renews with the app client, saves the rotated token first and pages the inbox", async () => {
    const world = new World(postenBring, [
      on(
        TOKEN,
        json({ access_token: "a1", refresh_token: madeUp("refresh", "1"), expires_in: 3600 }),
      ),
      on(
        INBOX,
        json({ parcels: [parcel("TEST00000001NO", "underway")], remainingCount: 1 }),
        json({
          parcels: [
            parcel("TEST00000002NO", "archived", [
              { type: "delivered", date: "2026-11-10T10:00:00Z" },
              { type: "added_by_user", date: "2026-11-11T10:00:00Z" },
            ]),
          ],
          remainingCount: 0,
        }),
      ),
    ]);
    const result = await world.fetchAccount(CONFIG, SECRET);
    expect(world.calls[0]?.headers.get("authorization")).toMatch(/^Basic /);
    expect(formOf(world.calls[0]).get("grant_type")).toBe("refresh_token");
    expect(world.saved[0]).toMatchObject({ refreshToken: madeUp("refresh", "1") });
    expect(JSON.parse(world.calls[2]?.body ?? "{}")).toMatchObject({ exclude: ["TEST00000001NO"] });
    expect(result.complete).toBe(false);
    expect(result.snapshots.map((found) => found.status)).toEqual(["in_transit", "delivered"]);
    expect(result.snapshots[1]?.deliveredAt).toBe("2026-11-10T10:00:00.000Z");
  });

  it("asks for a new sign-in only when the grant itself is refused", async () => {
    const world = new World(postenBring, [on(TOKEN, json({ error: "invalid_grant" }, 400))]);
    await expect(world.fetchAccount(CONFIG, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    const offline = new World(postenBring, [on(TOKEN, new TypeError("fetch failed"))]);
    await expect(offline.fetchAccount(CONFIG, SECRET)).rejects.not.toBeInstanceOf(
      SignInRejectedError,
    );
  });

  it("checks the pasted app address against the sign-in it started", async () => {
    const world = new World(postenBring, [
      on(TOKEN, json({ access_token: "a1", refresh_token: madeUp("refresh", "2") })),
    ]);
    const flow = postenBring.signIn as InteractiveSignIn<
      { brand: "bring" },
      { refreshToken: string }
    >;
    const context = {
      config: { brand: "bring" as const },
      kind: "account" as const,
      http: world.base().http,
      clock: world.clock,
    };
    const started = await flow.start(context);
    expect("step" in started && started.step.kind).toBe("open_url");
    const state = "state" in started ? started.state : null;
    const sent = (state as { state: string }).state;
    await expect(
      flow.continue(context, state, { pasted: "posten://login?code=x" }),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    const done = await flow.continue(context, state, {
      pasted: `bring://login?code=c1&state=${sent}`,
    });
    expect(done).toEqual({ secret: { refreshToken: madeUp("refresh", "2") } });
  });
});
