import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  RateLimitedError,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../src/plugin/api.js";
import { fetchAccount, formOf, header, idToken, json, World, type Route } from "./dhl-harness.js";
import { pasted } from "./pasted.js";

// Made-up values only: no real tracking numbers, names or addresses.
const CODE = "00340000000000000001";
const OTHER = "00340000000000000002";
// Assembled from parts so it never reads as a literal credential.
const REFRESH = ["refresh", "made", "up"].join("-");
const TOKEN_URL = "https://login.dhl.de/tenant/login/token";

function discovery(world: World): void {
  world.routes.push(({ url }) =>
    url.pathname.endsWith("/.well-known/openid-configuration")
      ? json({
          authorization_endpoint: "https://login.dhl.de/tenant/login/authorize",
          token_endpoint: TOKEN_URL,
        })
      : undefined,
  );
}

/** Token endpoint answering from a script; each entry is used once. */
function tokens(world: World, script: (Response | Error)[]): void {
  world.routes.push(({ url }) => {
    if (url.toString() !== TOKEN_URL) {
      return undefined;
    }
    const next = script.shift() ?? json({ error: "exhausted" }, 500);
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
}

function tokenResponse(tag: string, refresh: string | null = null) {
  return json({
    access_token: `at-${tag}`,
    id_token: idToken(true, tag),
    expires_in: 1800,
    ...(refresh === null ? {} : { refresh_token: refresh }),
  });
}

function inbox(world: World, answers: (Response | ((url: URL) => Response))[]): void {
  world.routes.push((({ url }) => {
    if (url.hostname !== "www.dhl.de") {
      return undefined;
    }
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (next === undefined) {
      return json({}, 500);
    }
    return typeof next === "function" ? next(url) : next.clone();
  }) satisfies Route);
}

function element(code: string, extra: { verlauf?: object; details?: object; info?: object } = {}) {
  return {
    id: code,
    sendungsinfo: {
      sendungsrichtung: "ANKOMMEND",
      sendungsname: "Beispiel &amp; Co",
      ...extra.info,
    },
    sendungsdetails: {
      sendungsverlauf: {
        fortschritt: 3,
        maximalFortschritt: 5,
        status: "Die Sendung wurde im Start-Paketzentrum bearbeitet.",
        datumAktuellerStatus: "2026-11-17T08:00:00",
        events: [
          {
            datum: "2026-11-16T23:03:58",
            status:
              "Die Auftragsdaten zu dieser Sendung wurden vom Absender elektronisch an DHL übermittelt.",
          },
          {
            datum: "2026-11-17T08:00:00",
            status: "Die Sendung wurde im Start-Paketzentrum bearbeitet.",
          },
        ],
        ...extra.verlauf,
      },
      ...extra.details,
    },
  };
}

describe("DHL Germany sign-in", () => {
  it("starts with a fresh PKCE challenge and state every time", async () => {
    const world = new World();
    const first = await pasted(world.plugin).start({}, world.clock);
    const second = await pasted(world.plugin).start({}, world.clock);
    expect(first.state.flow).toBe("de_account");
    const url = new URL(first.url);
    expect(url.hostname).toBe("login.dhl.de");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("openid offline_access");
    expect(url.searchParams.get("claims")).toContain("post_number");
    const { verifier, state } = first.state.inner as { verifier: string; state: string };
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(second.url).not.toBe(first.url);
  });

  it("exchanges the pasted address for a refresh token", async () => {
    const world = new World();
    discovery(world);
    tokens(world, [tokenResponse("first", REFRESH)]);
    const driver = pasted(world.plugin);
    const started = await driver.start({}, world.clock);
    const { verifier, state } = started.state.inner as { verifier: string; state: string };

    await expect(
      driver.finish(
        world.http,
        world.clock,
        started.state,
        "dhllogin://de.deutschepost.dhl/login?code=c1&state=wrong",
      ),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    expect(world.calls).toEqual([]);

    const secret = await driver.finish(
      world.http,
      world.clock,
      started.state,
      `dhllogin://de.deutschepost.dhl/login?code=c1&state=${state}`,
    );
    expect(secret).toEqual({ refreshToken: REFRESH });
    const tokenCall = world.calls.find((c) => c.url.toString() === TOKEN_URL);
    const form = formOf(tokenCall);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code_verifier")).toBe(verifier);
    expect(header(tokenCall, "authorization")).toMatch(/^Basic /);
  });
});

describe("DHL Germany account", () => {
  it("lists active parcels with Berlin times, windows, pickup and returns", async () => {
    const world = new World();
    discovery(world);
    tokens(world, [tokenResponse("first")]);
    inbox(world, [
      json({
        sendungen: [
          element(CODE, {
            verlauf: {
              fortschritt: 4,
              status: "Die Sendung wurde in das Zustellfahrzeug geladen.",
            },
            details: {
              zustellung: {
                zustellzeitfensterVon: "2026-11-18T13:00:00+01:00",
                zustellzeitfensterBis: "2026-11-18T15:00:00+01:00",
              },
              liveTracking: { lat: 1, lon: 2 },
            },
          }),
          element(OTHER, {
            verlauf: {
              fortschritt: 4,
              events: [
                {
                  datum: "2026-11-18T09:00:00",
                  status:
                    'Die Sendung liegt in der <a href="#">Packstation 101, Beispielweg 1, 00000 Musterstadt</a> zur Abholung bereit.',
                },
              ],
            },
            details: {
              zustellung: { packageStationType: "PACKAGE_STATION_SMART", abholcodeAvailable: true },
            },
          }),
          element("00340000000000000003", { details: { retoure: true } }),
          element("00340000000000000004", { info: { sendungsliste: "ARCHIVIERT" } }),
          { id: "00340000000000000005", sendungNichtGefunden: { keineDatenVerfuegbar: true } },
        ],
      }),
    ]);
    const result = await fetchAccount(world.context({ refreshToken: REFRESH }));

    expect(result.complete).toBe(true);
    expect(result.snapshots.map((s) => s.barcode)).toEqual([CODE, OTHER, "00340000000000000003"]);
    const [active, station, returning] = result.snapshots;
    expect(active).toMatchObject({
      status: "out_for_delivery",
      sender: "Beispiel & Co",
      plannedFrom: "2026-11-18T12:00:00.000Z",
      plannedTo: "2026-11-18T14:00:00.000Z",
      url: expect.stringContaining(`piececode=${CODE}`) as string,
    });
    expect(active?.history[0]).toMatchObject({
      at: "2026-11-16T22:03:58.000Z",
      status: "registered",
    });
    expect(JSON.stringify(active?.raw)).not.toContain("liveTracking");
    expect(station).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "Packstation 101, Beispielweg 1, 00000 Musterstadt",
    });
    expect(returning?.status).toBe("returning");

    const inboxCall = world.calls.find((c) => c.url.hostname === "www.dhl.de");
    expect(header(inboxCall, "cookie")).toBe(`dhli=${idToken(true, "first")}`);
    expect(inboxCall?.init.redirect).toBe("manual");
  });

  it("reuses a valid ID token and saves a rotated refresh token", async () => {
    const world = new World();
    discovery(world);
    const script = [tokenResponse("first", "rotated-made-up")];
    tokens(world, script);
    inbox(world, [json({ sendungen: [] })]);
    const context = world.context({ refreshToken: REFRESH });
    await fetchAccount(context);
    world.clock.advance(10 * 60_000);
    await fetchAccount(context);

    expect(world.calls.filter((c) => c.url.toString() === TOKEN_URL)).toHaveLength(1);
    const form = formOf(world.calls.find((c) => c.url.toString() === TOKEN_URL));
    expect(form.get("refresh_token")).toBe(REFRESH);
    expect(world.stored).toMatchObject({ refreshToken: "rotated-made-up" });

    // Past the lifetime the rotated token is the one used.
    script.push(tokenResponse("second"));
    world.clock.advance(30 * 60_000);
    await fetchAccount(context);
    const last = world.calls.filter((c) => c.url.toString() === TOKEN_URL).at(-1);
    expect(formOf(last).get("refresh_token")).toBe("rotated-made-up");
  });

  it("renews once after a 401 and gives up on a second one", async () => {
    const world = new World();
    discovery(world);
    tokens(world, [tokenResponse("first"), tokenResponse("second")]);
    inbox(world, [json({}, 401), json({ sendungen: [element(CODE)] })]);
    const result = await fetchAccount(world.context({ refreshToken: REFRESH }));
    expect(result.snapshots).toHaveLength(1);

    const refused = new World();
    discovery(refused);
    tokens(refused, [tokenResponse("first"), tokenResponse("second")]);
    inbox(refused, [json({}, 401)]);
    await expect(fetchAccount(refused.context({ refreshToken: REFRESH }))).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
    expect(refused.calls.filter((c) => c.url.hostname === "www.dhl.de")).toHaveLength(2);
  });

  it("asks for a new sign-in only when DHL refuses the grant", async () => {
    const rejected = new World();
    discovery(rejected);
    tokens(rejected, [json({ error: "invalid_grant" }, 400)]);
    await expect(fetchAccount(rejected.context({ refreshToken: REFRESH }))).rejects.toBeInstanceOf(
      SignInRejectedError,
    );

    for (const failure of [
      new Error("ETIMEDOUT"),
      json({ error: "temporarily_unavailable" }, 503),
    ]) {
      const world = new World();
      discovery(world);
      tokens(world, [failure]);
      const error: unknown = await fetchAccount(world.context({ refreshToken: REFRESH })).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(TransientError);
    }

    const unlinked = new World();
    discovery(unlinked);
    tokens(unlinked, [json({ access_token: "at", id_token: idToken(false) })]);
    await expect(fetchAccount(unlinked.context({ refreshToken: REFRESH }))).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
  });

  it("stops on a rate limit or a page that is not JSON", async () => {
    const limited = new World();
    discovery(limited);
    tokens(limited, [tokenResponse("first")]);
    inbox(limited, [json({ rateLimited: true, sendungen: [] })]);
    await expect(fetchAccount(limited.context({ refreshToken: REFRESH }))).rejects.toBeInstanceOf(
      RateLimitedError,
    );

    const html = new World();
    discovery(html);
    tokens(html, [tokenResponse("first")]);
    inbox(html, [new Response("<html>consent</html>", { status: 200 })]);
    await expect(fetchAccount(html.context({ refreshToken: REFRESH }))).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it("leaves archived parcels out even when nothing else is left, so they never flip back", async () => {
    const world = new World();
    discovery(world);
    tokens(world, [tokenResponse("first")]);
    inbox(world, [json({ sendungen: [element(CODE, { info: { sendungsliste: "ARCHIVIERT" } })] })]);
    const result = await fetchAccount(world.context({ refreshToken: REFRESH }));
    expect(result.snapshots).toEqual([]);
  });

  it("looks bare inbox entries up by number", async () => {
    const world = new World();
    discovery(world);
    tokens(world, [tokenResponse("first")]);
    inbox(world, [
      (url) =>
        url.searchParams.has("piececode")
          ? json({ sendungen: [element(CODE)] })
          : json({ sendungen: [{ id: CODE, sendungsdetails: {} }] }),
    ]);
    const result = await fetchAccount(world.context({ refreshToken: REFRESH }));
    expect(result.snapshots[0]?.status).toBe("in_transit");
    expect(world.calls.filter((c) => c.url.searchParams.get("piececode") === CODE)).toHaveLength(1);
  });

  it("needs a sign-in before the first run", async () => {
    await expect(fetchAccount(new World().context(null))).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
  });
});
