import { createHash } from "node:crypto";
import { loadRules } from "open-parcels-rules";
import { describe, expect, it } from "vitest";
import {
  readAccount,
  MAX_SHIPMENT_LOADS,
  type AmazonContext,
} from "../../src/carriers/amazon/account.js";
import { authorizationCode, registerDevice, signInUrl } from "../../src/carriers/amazon/auth.js";
import { pastDay } from "../../src/carriers/amazon/dates.js";
import { amazonCarrier } from "../../src/carriers/amazon/index.js";
import { readLive, stopsFromCallout } from "../../src/carriers/amazon/live.js";
import { STOREFRONTS } from "../../src/carriers/amazon/storefronts.js";
import { BUILTIN_CARRIERS } from "../../src/engine/builtin-carriers.js";
import {
  CaptchaError,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../src/plugin/api.js";
import { FakeClock } from "../helpers.js";
import { fakeContext, fakeNetwork, html, json } from "./harness.js";
import {
  CAPTCHA_PAGE,
  cookieExchange,
  linePage,
  ordersPage,
  SIGN_IN_PAGE,
  tilePath,
  trackPage,
  trackPath,
  type TileSpec,
} from "./amazon-fixtures.js";
import { pasted } from "./pasted.js";

const rules = loadRules();
const plugin = amazonCarrier(rules);
const SERIAL = "0123456789ABCDEF0123456789ABCDEF";
/** Built from parts, so no literal credential sits in the file. */
const REFRESH = ["Atnr", "made", "up"].join("|");

/** Every request goes to one function of its URL. */
type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

interface Harness {
  readonly context: AmazonContext;
  /** "METHOD path" of every request. */
  readonly calls: string[];
  readonly unknown: [string, string][];
  readonly stored: unknown;
}

function harness(route: Route, stored: unknown = null): Harness {
  const network = fakeNetwork([(call) => route(call.url, call.init)]);
  const fake = fakeContext(plugin.http, network.fetchImpl, { session: stored });
  const context: AmazonContext = {
    ...fake.base,
    config: { storefront: "amazon.de" },
    secret: { refreshToken: REFRESH, deviceSerial: SERIAL },
    session: {
      load: () => fake.base.session.load(),
      // A copy, as the encrypted store would keep it: later changes to the object never leak in.
      save: (value) => fake.base.session.save(JSON.parse(JSON.stringify(value)) as unknown),
    },
  };
  return {
    context,
    get calls() {
      return network.calls.map((call) => `${call.method} ${call.url.pathname}`);
    },
    get unknown() {
      return fake.reports.map(({ kind, key }): [string, string] => [kind, key]);
    },
    get stored() {
      return fake.stored();
    },
  };
}

/** A storefront that serves the given order lines and package pages. */
function storefront(tiles: readonly TileSpec[], pages: Record<string, string>): Route {
  return (url) => {
    if (url.pathname === "/ap/exchangetoken/cookies") {
      return json(cookieExchange("amazon.de"));
    }
    if (url.pathname === "/your-orders/orders") {
      return html(ordersPage(tiles));
    }
    if (url.pathname === "/gp/your-account/order-details") {
      const orderId = url.searchParams.get("orderId") ?? "";
      const tile = tiles.find((entry) => entry.orderId === orderId);
      return html(linePage(orderId, tile?.shipmentId ?? ""));
    }
    if (url.pathname === "/progress-tracker/package") {
      const page = pages[url.searchParams.get("shipmentId") ?? ""];
      return page === undefined ? html("", 404) : html(page);
    }
    return html("", 404);
  };
}

const OWN_FLEET: TileSpec = {
  orderId: "000-1111111-0000001",
  shipmentId: "SHIPOWN1",
  lineItemId: "L1",
  title: "Example kettle, blue",
  status: "Zustellung heute",
};
const BY_DHL: TileSpec = {
  orderId: "000-1111111-0000002",
  shipmentId: "SHIPDHL1",
  title: "Example book",
  status: "Ankunft 20. Nov.",
  direct: true,
};
const BY_DPD: TileSpec = {
  orderId: "000-1111111-0000004",
  shipmentId: "SHIPDPD1",
  title: "Example lamp",
  status: "Versandt",
  direct: true,
};
const CANCELLED: TileSpec = {
  orderId: "000-1111111-0000003",
  title: "Example toy",
  status: "Storniert",
};

const PAGES: Record<string, string> = {
  SHIPOWN1: trackPage({
    trackingId: "DE0000000001",
    shortStatus: "OUT_FOR_DELIVERY",
    promiseMessage: "Zustellung heute 14:00 - 16:30",
    // The fake clock starts at 13:00 Berlin; the window ends 3.5 h later.
    windowEndsInMs: 3.5 * 60 * 60_000,
    callout: "4 Stopps entfernt",
    events: [
      {
        date: "Montag, 16. November",
        time: "08:10",
        message: "Das Paket hat einen Amazon-Standort verlassen",
        location: "Exampletown",
      },
      { date: "Heute", time: "07:45", message: "Sendung wird zugestellt" },
    ],
  }),
  SHIPDHL1: trackPage({
    trackingId: "00340000000000000001",
    shortStatus: "IN_TRANSIT",
    milestone: "SHIPPED",
    carrierLine: "Zustellung durch DHL",
  }),
  SHIPDPD1: trackPage({
    trackingId: "01234567890123",
    shortStatus: "IN_TRANSIT",
    carrierLine: "Delivered by DPDDE",
  }),
};

describe("Amazon sign-in", () => {
  it("builds a PKCE sign-in address for the storefront's language", () => {
    const verifier = "v".repeat(43);
    const url = new URL(signInUrl(STOREFRONTS["amazon.de"], SERIAL, verifier));
    expect(url.hostname).toBe("www.amazon.com");
    expect(url.searchParams.get("language")).toBe("de_DE");
    expect(url.searchParams.get("openid.oa2.code_challenge")).toBe(
      createHash("sha256").update(verifier).digest("base64url"),
    );
  });

  it("takes the code only from an Amazon landing address", () => {
    const code = "made-up-code";
    expect(
      authorizationCode(
        `https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=${code}`,
      ),
    ).toBe(code);
    expect(
      authorizationCode(`https://evil.example.invalid/?openid.oa2.authorization_code=${code}`),
    ).toBeNull();
    expect(authorizationCode("https://www.amazon.de/ap/maplanding")).toBeNull();
    expect(authorizationCode("not a url")).toBeNull();
  });

  it("falls back to the global host when the regional one is down", async () => {
    const h = harness((url) =>
      url.hostname === "api.amazon.de"
        ? json({}, 503)
        : json({ response: { success: { tokens: { bearer: { refresh_token: REFRESH } } } } }),
    );
    const state = { deviceSerial: SERIAL, verifier: "v".repeat(43), storefront: "amazon.de" };
    await expect(
      registerDevice(h.context.http, STOREFRONTS["amazon.de"], state, "c"),
    ).resolves.toEqual({
      refreshToken: REFRESH,
      deviceSerial: SERIAL,
    });
  });

  it("counts a refusal only when every host that answered refused", async () => {
    const state = { deviceSerial: SERIAL, verifier: "v".repeat(43), storefront: "amazon.de" };
    const refused = harness(() => json({}, 400));
    await expect(
      registerDevice(refused.context.http, STOREFRONTS["amazon.de"], state, "c"),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    const mixed = harness((url) => {
      if (url.hostname === "api.amazon.de") {
        throw new Error("network down");
      }
      return json({}, 500);
    });
    await expect(
      registerDevice(mixed.context.http, STOREFRONTS["amazon.de"], state, "c"),
    ).rejects.toBeInstanceOf(TransientError);
  });
});

describe("Amazon account", () => {
  it("lists shipments with items, windows, history and hand-offs", async () => {
    const h = harness(storefront([OWN_FLEET, BY_DHL, BY_DPD, CANCELLED], PAGES));
    const result = await readAccount(h.context, rules);
    expect(result.complete).toBe(true);
    const [own, dhl, dpd] = result.snapshots;
    expect(result.snapshots).toHaveLength(3);

    expect(own).toMatchObject({
      carrier: "amazon",
      barcode: "DE0000000001",
      status: "out_for_delivery",
      handoff: null,
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:30:00.000Z",
      order: { shop: "amazon", orderNumber: OWN_FLEET.orderId },
      externalRef: `${OWN_FLEET.orderId}/SHIPOWN1`,
    });
    expect(own?.items.map((item) => item.title)).toEqual(["Example kettle, blue"]);
    expect(own?.history.map((event) => event.at)).toEqual([
      "2026-11-18T06:45:00.000Z",
      "2026-11-16T07:10:00.000Z",
    ]);
    expect(own?.history[1]).toMatchObject({ status: "in_transit", location: "Exampletown" });
    expect(own?.live).toEqual({
      ref: {
        trackingId: "DE0000000001",
        csrfToken: "made-up-csrf-token",
        callout: "4 Stopps entfernt",
      },
      mapShown: true,
    });

    expect(dhl).toMatchObject({
      status: "in_transit",
      handoff: { carrier: "dhl", barcode: "00340000000000000001" },
      plannedFrom: "2026-11-19T23:00:00.000Z",
      live: null,
    });
    expect(dpd?.handoff).toEqual({ carrier: "dpd", barcode: "01234567890123" });
  });

  it("never stores the account id, the map key or destination coordinates", async () => {
    const h = harness(storefront([OWN_FLEET], PAGES));
    const result = await readAccount(h.context, rules);
    const kept = JSON.stringify([h.stored, result.snapshots.map((s) => ({ ...s, live: null }))]);
    expect(kept).not.toContain("AEXAMPLECUSTOMER");
    expect(kept).not.toContain("made-up-map-key");
    expect(kept).not.toContain("11.111");
    expect(kept).not.toContain("made-up-csrf-token");
  });

  it("mints cookies only when the jar is empty, and reuses them next time", async () => {
    const route = storefront([OWN_FLEET], PAGES);
    const first = harness(route);
    await readAccount(first.context, rules);
    expect(first.calls.filter((call) => call.endsWith("/cookies"))).toHaveLength(1);
    const second = harness(route, first.stored);
    await readAccount(second.context, rules);
    expect(second.calls.filter((call) => call.endsWith("/cookies"))).toHaveLength(0);
  });

  it("renews cookies once on a sign-in page, then reports the sign-in as refused", async () => {
    const seeded = harness(storefront([OWN_FLEET], PAGES));
    await readAccount(seeded.context, rules);
    const h = harness((url) => {
      if (url.pathname === "/ap/exchangetoken/cookies") {
        return json(cookieExchange("amazon.de"));
      }
      if (url.pathname === "/ap/signin") {
        return html(SIGN_IN_PAGE);
      }
      return new Response(null, {
        status: 302,
        headers: { location: "/ap/signin?openid.return_to=x" },
      });
    }, seeded.stored);
    await expect(readAccount(h.context, rules)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(h.calls.filter((call) => call.endsWith("/cookies"))).toHaveLength(1);
  });

  it("never signs in again on a network error", async () => {
    const seeded = harness(storefront([OWN_FLEET], PAGES));
    await readAccount(seeded.context, rules);
    const h = harness((url) => {
      if (url.pathname === "/ap/exchangetoken/cookies") {
        return json(cookieExchange("amazon.de"));
      }
      throw new Error("connection reset");
    }, seeded.stored);
    await expect(readAccount(h.context, rules)).rejects.toBeInstanceOf(TransientError);
    expect(h.calls.filter((call) => call.endsWith("/cookies"))).toHaveLength(0);
  });

  it("treats a bot-wall 403 as transient and never renews cookies for it", async () => {
    const seeded = harness(storefront([OWN_FLEET], PAGES));
    await readAccount(seeded.context, rules);
    const h = harness((url) => {
      if (url.pathname === "/ap/exchangetoken/cookies") {
        return json(cookieExchange("amazon.de"));
      }
      return html("<html><body>Request blocked.</body></html>", 403);
    }, seeded.stored);
    await expect(readAccount(h.context, rules)).rejects.toBeInstanceOf(TransientError);
    expect(h.calls.filter((call) => call.endsWith("/cookies"))).toHaveLength(0);
  });

  it("is not complete while older order pages follow", async () => {
    const paged: Route = (url, init) =>
      url.pathname === "/your-orders/orders"
        ? html(
            `${ordersPage([OWN_FLEET])}<ul class="a-pagination"><li class="a-last">` +
              `<a href="/your-orders/orders?startIndex=10">Next</a></li></ul>`,
          )
        : storefront([OWN_FLEET], PAGES)(url, init);
    const result = await readAccount(harness(paged).context, rules);
    expect(result.snapshots).toHaveLength(1);
    expect(result.complete).toBe(false);
  });

  it("treats a refused refresh token as a refused sign-in", async () => {
    const h = harness(() => json({ response: { error: { code: "InvalidToken" } } }, 400));
    await expect(readAccount(h.context, rules)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("pauses on a captcha instead of solving it", async () => {
    const h = harness((url) =>
      url.pathname === "/ap/exchangetoken/cookies"
        ? json(cookieExchange("amazon.de"))
        : html(CAPTCHA_PAGE),
    );
    await expect(readAccount(h.context, rules)).rejects.toBeInstanceOf(CaptchaError);
  });

  it("keeps known parcels when the orders page shows no line", async () => {
    const h = harness(storefront([], PAGES));
    await expect(readAccount(h.context, rules)).resolves.toEqual({
      snapshots: [],
      complete: false,
    });
    expect(h.unknown).toContainEqual(["page", "orders_without_lines"]);
  });

  it("stops on an orders page that does not exist", async () => {
    const h = harness((url) =>
      url.pathname === "/ap/exchangetoken/cookies"
        ? json(cookieExchange("amazon.de"))
        : html("", 404),
    );
    await expect(readAccount(h.context, rules)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("caps the shipments loaded per run and rotates through the rest", async () => {
    const tiles: TileSpec[] = Array.from({ length: MAX_SHIPMENT_LOADS + 2 }, (_, index) => ({
      orderId: `000-2222222-${String(index).padStart(7, "0")}`,
      shipmentId: `SHIPCAP${String(index)}`,
      title: `Example item ${String(index)}`,
      status: "Versandt",
      direct: true,
    }));
    const pages: Record<string, string> = Object.fromEntries(
      tiles.map((tile, index): [string, string] => [
        tile.shipmentId ?? "",
        trackPage({
          trackingId: `DE00000001${String(index).padStart(2, "0")}`,
          shortStatus: "IN_TRANSIT",
        }),
      ]),
    );
    const first = harness(storefront(tiles, pages));
    const one = await readAccount(first.context, rules);
    expect(one.snapshots).toHaveLength(MAX_SHIPMENT_LOADS);
    expect(one.complete).toBe(false);
    const second = harness(storefront(tiles, pages), first.stored);
    const two = await readAccount(second.context, rules);
    expect(two.snapshots).toHaveLength(tiles.length);
    expect(two.complete).toBe(true);
    expect(second.calls.filter((call) => call.startsWith("GET /progress-tracker"))).toHaveLength(
      MAX_SHIPMENT_LOADS,
    );
  });

  it("does not load a delivered shipment again", async () => {
    const delivered: TileSpec = { ...BY_DHL, status: "Zugestellt am 17. November" };
    const pages = {
      SHIPDHL1: trackPage({
        trackingId: "00340000000000000001",
        shortStatus: "DELIVERED",
        carrierLine: "Zustellung durch DHL",
        events: [{ date: "Dienstag, 17. November", time: "11:20", message: "Zugestellt" }],
      }),
    };
    const first = harness(storefront([delivered], pages));
    const one = await readAccount(first.context, rules);
    expect(one.snapshots[0]).toMatchObject({
      delivered: true,
      deliveredAt: "2026-11-17T10:20:00.000Z",
    });
    const second = harness(storefront([delivered], pages), first.stored);
    const two = await readAccount(second.context, rules);
    expect(second.calls.some((call) => call.startsWith("GET /progress-tracker"))).toBe(false);
    expect(two.snapshots[0]).toMatchObject({ barcode: "00340000000000000001", delivered: true });
  });

  it("follows only links on the storefront", () => {
    expect(tilePath(OWN_FLEET)).toMatch(/^\/gp\//);
    expect(trackPath("1", "2")).toMatch(/^\/progress-tracker\/package\?/);
  });
});

describe("Amazon dates", () => {
  const now = new Date("2026-11-18T12:00:00Z");
  it("reads past days, rolling dates that would lie ahead back a year", () => {
    expect(pastDay(rules, "Dienstag, 3. November", now, "Europe/Berlin")).toEqual({
      year: 2026,
      month: 11,
      day: 3,
    });
    expect(pastDay(rules, "Gestern", now, "Europe/Berlin")).toEqual({
      year: 2026,
      month: 11,
      day: 17,
    });
    expect(pastDay(rules, "Delivered 30 December", now, "Europe/Berlin")).toEqual({
      year: 2025,
      month: 12,
      day: 30,
    });
    expect(pastDay(rules, "irgendwann", now, "Europe/Berlin")).toBeNull();
  });
});

describe("Amazon courier map", () => {
  async function seeded(): Promise<unknown> {
    const h = harness(storefront([OWN_FLEET], PAGES));
    await readAccount(h.context, rules);
    return h.stored;
  }
  const target = {
    ref: {
      trackingId: "DE0000000001",
      csrfToken: "made-up-csrf-token",
      callout: "4 Stopps entfernt",
    },
    mapShown: true,
  };
  const answer = (state: string, extra: Record<string, unknown> = {}): unknown => ({
    success: true,
    packageLocationDetails: {
      trackingObjectState: state,
      transporterDetails: { geoLocation: { latitude: 10.5, longitude: 20.25 } },
      destinationAddress: { geoLocation: { latitude: 11.111, longitude: 22.222 } },
      ...extra,
    },
  });

  it("reads the courier's position and the stops from the callout", async () => {
    const h = harness(() => json(answer("RENDERED")), await seeded());
    await expect(readLive(h.context, target)).resolves.toEqual({
      state: "en_route",
      stopsAway: 4,
      latitude: 10.5,
      longitude: 20.25,
      accuracy: null,
      positionAt: null,
      message: "4 Stopps entfernt",
    });
  });

  it("reads the map's string stop count and fix time, and posts the page's JSON body", async () => {
    let sent: unknown = null;
    const h = harness(
      (_url, init) => {
        expect(typeof init.body).toBe("string");
        sent = JSON.parse(init.body as string);
        return json({
          success: true,
          responseCode: "SUCCESS",
          packageLocationDetails: {
            trackingObjectState: "PICKED_UP",
            stopsRemaining: "2",
            transporterDetails: {
              transporterSessionState: "ACTIVE",
              geoLocation: {
                latitude: 10.5,
                longitude: 20.25,
                accuracy: 12,
                locationTime: 1_800_000_000,
              },
            },
          },
        });
      },
      await seeded(),
    );
    await expect(readLive(h.context, target)).resolves.toEqual({
      state: "en_route",
      stopsAway: 2,
      latitude: 10.5,
      longitude: 20.25,
      accuracy: 12,
      positionAt: new Date(1_800_000_000_000).toISOString(),
      message: "4 Stopps entfernt",
    });
    expect(sent).toEqual({
      formData: { trackingId: ["DE0000000001"], csrfToken: ["made-up-csrf-token"] },
    });
  });

  it("never hands out a position once the courier is next", async () => {
    const h = harness(() => json(answer("YOU_ARE_NEXT", { stopsRemaining: 0 })), await seeded());
    await expect(readLive(h.context, target)).resolves.toMatchObject({
      state: "next_stop",
      stopsAway: 0,
      latitude: null,
      longitude: null,
    });
  });

  it("returns null without a session or map", async () => {
    const empty = harness(() => json(answer("RENDERED")));
    await expect(readLive(empty.context, target)).resolves.toBeNull();
    const off = harness(() => json({ success: false }), await seeded());
    await expect(readLive(off.context, target)).resolves.toBeNull();
    await expect(
      readLive(off.context, { ref: { trackingId: "x", csrfToken: null }, mapShown: false }),
    ).resolves.toBeNull();
  });

  it("stops on unknown states and reports a gone session without signing in", async () => {
    const stored = await seeded();
    const odd = harness(() => json(answer("TELEPORTED")), stored);
    await expect(readLive(odd.context, target)).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(odd.unknown).toContainEqual(["live_state", "TELEPORTED"]);
    const gone = harness(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://www.amazon.de/ap/signin" },
        }),
      stored,
    );
    await expect(readLive(gone.context, target)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(gone.calls.some((call) => call.endsWith("/cookies"))).toBe(false);
  });

  it("reads stop counts from callouts", () => {
    expect(stopsFromCallout("12 stops away")).toBe(12);
    expect(stopsFromCallout("Sie sind der Nächste")).toBeNull();
    expect(stopsFromCallout(null)).toBeNull();
  });
});

describe("Amazon registration", () => {
  it("is shipped as a built-in shop with a pasted-link sign-in", () => {
    const amazon = BUILTIN_CARRIERS.find((entry) => entry.info.id === "amazon");
    expect(amazon?.info).toMatchObject({ sourceKinds: ["shop"], signIn: "interactive" });
    expect(amazon?.info.signInFlows.map((flow) => flow.id)).toEqual(["pasted_redirect"]);
    expect(amazon?.canReadLive).toBe(true);
    expect(amazon?.http.userAgent?.reason).toBeTruthy();
  });

  it("starts a sign-in with a fresh device and finishes it from the pasted address", async () => {
    const amazon = BUILTIN_CARRIERS.find((entry) => entry.info.id === "amazon");
    if (amazon === undefined) {
      throw new Error("Amazon is not registered.");
    }
    const clock = new FakeClock();
    const started = await pasted(amazon).start({ storefront: "amazon.de" }, clock);
    expect(started.url).toContain("openid.oa2.code_challenge=");
    const h = harness(() =>
      json({ response: { success: { tokens: { bearer: { refresh_token: REFRESH } } } } }),
    );
    const finished = await pasted(amazon).finish(
      h.context.http,
      clock,
      started.state,
      "https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=made-up",
    );
    expect(finished).toMatchObject({ refreshToken: REFRESH });
    await expect(
      pasted(amazon).finish(
        h.context.http,
        clock,
        started.state,
        "https://www.amazon.com/ap/maplanding",
      ),
    ).rejects.toBeInstanceOf(SignInRejectedError);
  });
});
