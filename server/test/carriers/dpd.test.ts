import { describe, expect, it } from "vitest";
import { dpd } from "../../src/carriers/dpd/index.js";
import { fetchDeAccount } from "../../src/carriers/dpd/account.js";
import { accountStatus } from "../../src/carriers/dpd/account-normalize.js";
import { trackDe } from "../../src/carriers/dpd/tracking.js";
import { inferYears, localIso } from "../../src/carriers/dpd/time.js";
import {
  CaptchaError,
  SignInRejectedError,
  TransientError,
  type FetchResult,
  type PluginContext,
} from "../../src/plugin/api.js";
import {
  BARCODE_IN,
  BARCODE_IN2,
  BARCODE_OUT,
  inboxPage,
  lifeCycle,
  LOGIN_PAGE_CAPTCHA,
  LOGIN_PAGE_PRISTINE,
  LOGIN_PAGE_REJECTED,
  PORTAL_DASHBOARD,
} from "./dpd-fixtures.js";
import { fakeContext, fakeNetwork, html, json } from "./harness.js";

type Reply = Response | Error | ((body: string) => Response | Error);

/** A scripted DPD: replies per `METHOD host/path`, served in order, the last one repeating. */
class FakeDpd {
  readonly routes = new Map<string, Reply[]>();
  readonly #network = fakeNetwork([
    (call) => {
      const queue = this.routes.get(call.key) ?? [];
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) {
        return new Error(`unexpected request ${call.key}`);
      }
      const reply = typeof next === "function" ? next(call.body ?? "") : next;
      return reply instanceof Error ? reply : reply.clone();
    },
  ]);
  readonly fetch = this.#network.fetchImpl;

  on(key: string, ...replies: Reply[]): this {
    this.routes.set(key, replies);
    return this;
  }

  get requests(): string[] {
    return this.#network.requests();
  }

  /** Drops the requests recorded so far. */
  forget(): void {
    this.#network.calls.length = 0;
  }

  get bodies(): string[] {
    return this.#network.calls.map((call) => call.body ?? "");
  }
}

const redirect = (location: string): Response =>
  new Response(null, { status: 302, headers: { location } });

const USERNAME = "someone@example.invalid";
const credentials = { username: USERNAME, password: ["made", "up", "words"].join("-") };

function context(fake: FakeDpd, options: { publicTracking?: boolean; saved?: unknown } = {}) {
  const fakeCtx = fakeContext(dpd.http, fake.fetch, { session: options.saved ?? null });
  const unknowns: string[] = [];
  const ctx: PluginContext<{ publicTracking: boolean }, typeof credentials | null> = {
    ...fakeCtx.base,
    reportUnknown: (kind, key) => {
      unknowns.push(`${kind}=${key}`);
    },
    config: { publicTracking: options.publicTracking ?? true },
    secret: credentials,
    session: {
      load: () => fakeCtx.base.session.load(),
      // A copy, as the encrypted store would keep it.
      save: (value) => fakeCtx.base.session.save(JSON.parse(JSON.stringify(value)) as unknown),
    },
  };
  return { ctx, unknowns, saved: () => fakeCtx.stored() };
}

type Ctx = ReturnType<typeof context>["ctx"];
const fetchAccount = (ctx: Ctx): Promise<FetchResult> => fetchDeAccount(ctx);
const track = (ctx: Ctx, codes: string[]): Promise<FetchResult> => trackDe(ctx, codes);

const INBOX = "my.dpd.de/myParcel.aspx";
const PORTAL = "portal.dpd.de/home_pn.aspx";
const LOGIN = "www.dpd.com/de/de/mydpd-anmelden-und-registrieren/";

const listed = inboxPage({
  rows: [{ barcode: BARCODE_IN, sentence: "Paket in Zustellung" }],
});
const withDetail = inboxPage({
  rows: [{ barcode: BARCODE_IN, sentence: "Paket in Zustellung" }],
  detail: {
    barcode: BARCODE_IN,
    weight: "2,5",
    slots: [
      ["Paketinfo an DPD übergeben", "16.11."],
      ["Paket unterwegs", "17.11."],
      ["Paket im Paketzustellzentrum", "18.11."],
      ["Paket in Zustellung", "18.11."],
    ],
  },
});

/** A signed-out account: the inbox renders empty, the portal bounces to the login page. */
function signedOut(fake: FakeDpd): FakeDpd {
  return fake
    .on(`GET ${INBOX}`, html(inboxPage({ rows: [], signedIn: false })))
    .on(`GET ${PORTAL}`, redirect(`https://${LOGIN}?lng=DEU`))
    .on(`GET ${LOGIN}`, html(LOGIN_PAGE_PRISTINE));
}

describe("DPD Germany account", () => {
  it("signs in when the session is gone and reads the parcel with its milestones", async () => {
    const fake = signedOut(new FakeDpd())
      .on(`POST ${LOGIN}`, redirect("https://portal.dpd.de/home_pn.aspx?dpd_token=made-up-token"))
      .on(`GET ${PORTAL}`, redirect(`https://${LOGIN}?lng=DEU`), html(PORTAL_DASHBOARD))
      .on(`POST ${PORTAL}`, html(listed))
      .on(`POST ${INBOX}`, html(withDetail));
    const { ctx } = context(fake);

    const result = await fetchAccount(ctx);

    expect(fake.requests.filter((key) => key === `POST ${LOGIN}`)).toHaveLength(1);
    expect(fake.bodies.some((body) => body.includes("hidZipCode"))).toBe(false);
    expect(result.complete).toBe(true);
    expect(result.snapshots).toHaveLength(1);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      carrier: "dpd",
      barcode: BARCODE_IN,
      direction: "incoming",
      status: "out_for_delivery",
      rawStatus: "Paket in Zustellung",
      weightKg: 2.5,
      plannedFrom: "2026-11-18T00:00:00+01:00",
      plannedTo: "2026-11-18T23:59:59+01:00",
      sender: null,
      receiver: null,
    });
    expect(parcel?.history.map((event) => event.status)).toEqual([
      "registered",
      "in_transit",
      "in_transit",
      "out_for_delivery",
    ]);
  });

  it("reuses the stored session and skips unchanged detail panels", async () => {
    const fake = new FakeDpd()
      .on(`GET ${INBOX}`, html(listed))
      .on(`POST ${INBOX}`, html(withDetail));
    const { ctx, saved } = context(fake);
    await fetchAccount(ctx);
    const again = context(fake, { saved: saved() });
    fake.forget();

    const result = await fetchAccount(again.ctx);

    expect(fake.requests).toEqual([`GET ${INBOX}`]);
    expect(result.snapshots[0]?.status).toBe("out_for_delivery");
  });

  it("never signs in again after a network error", async () => {
    const fake = new FakeDpd()
      .on(`GET ${INBOX}`, new TypeError("fetch failed"))
      .on(`POST ${LOGIN}`, redirect("https://portal.dpd.de/home_pn.aspx?dpd_token=x"));
    await expect(fetchAccount(context(fake).ctx)).rejects.toBeInstanceOf(TransientError);
    expect(fake.requests).toEqual([`GET ${INBOX}`]);
  });

  it("treats a server error as transient, not as a lost session", async () => {
    const fake = new FakeDpd().on(`GET ${INBOX}`, new Response("oops", { status: 502 }));
    await expect(fetchAccount(context(fake).ctx)).rejects.toBeInstanceOf(TransientError);
    expect(fake.requests).toEqual([`GET ${INBOX}`]);
  });

  it("reports a rejected password as a sign-in rejection", async () => {
    const fake = signedOut(new FakeDpd()).on(`POST ${LOGIN}`, html(LOGIN_PAGE_REJECTED));
    await expect(fetchAccount(context(fake).ctx)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("stops at a captcha instead of trying to solve it", async () => {
    const fake = signedOut(new FakeDpd()).on(`POST ${LOGIN}`, html(LOGIN_PAGE_CAPTCHA));
    await expect(fetchAccount(context(fake).ctx)).rejects.toBeInstanceOf(CaptchaError);
  });

  it("holds off signing in for an hour when a sign-in did not open the list", async () => {
    const fake = signedOut(new FakeDpd())
      .on(`POST ${LOGIN}`, redirect("https://portal.dpd.de/home_pn.aspx?dpd_token=x"))
      .on(`GET ${PORTAL}`, redirect(`https://${LOGIN}?lng=DEU`), html(PORTAL_DASHBOARD))
      .on(`POST ${PORTAL}`, html(inboxPage({ rows: [], signedIn: false })));
    const first = context(fake);
    await expect(fetchAccount(first.ctx)).rejects.toBeInstanceOf(TransientError);
    fake.on(`GET ${PORTAL}`, redirect(`https://${LOGIN}?lng=DEU`));
    const second = context(fake, { saved: first.saved() });
    fake.forget();
    await expect(fetchAccount(second.ctx)).rejects.toBeInstanceOf(TransientError);
    expect(fake.requests).not.toContain(`POST ${LOGIN}`);
  });

  it("reads the sent tab as outgoing and marks returns", async () => {
    const inbox = inboxPage({ rows: [], counters: { sending: 1 } });
    const sending = inboxPage({
      rows: [{ barcode: BARCODE_OUT, sentence: "Retoure an Versender - Geliefert", icon: 3 }],
    });
    const fake = new FakeDpd()
      .on(`GET ${INBOX}`, html(inbox))
      .on(`POST ${INBOX}`, (body) =>
        body.includes("btnGetSendingParcel") ? html(sending) : new Response("", { status: 500 }),
      );
    const { ctx } = context(fake);

    const result = await fetchAccount(ctx);

    expect(result.snapshots[0]).toMatchObject({
      barcode: BARCODE_OUT,
      direction: "outgoing",
      status: "returning",
      delivered: false,
    });
  });

  it("refuses to run without credentials", async () => {
    const { ctx } = context(new FakeDpd());
    await expect(fetchAccount({ ...ctx, secret: null })).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
  });
});

describe("DPD Germany status rules", () => {
  const slots = (filled: number) =>
    (["Start", "OnTheRoad", "DeliveryDepot", "CarLoad", "Delivered"] as const).map(
      (slot, index) => ({
        slot,
        text: index < filled ? `text ${index}` : "-",
        date: index < filled ? "18.11." : "-",
      }),
    );

  it("decides returns first, then the furthest dated milestone, then the sentence", () => {
    expect(accountStatus("Retoure an Versender - Geliefert", 6, slots(5))).toBe("returning");
    expect(accountStatus("anything", null, slots(5))).toBe("delivered");
    expect(accountStatus("anything", null, slots(2))).toBe("in_transit");
    expect(accountStatus("Paket liegt im Paketshop zur Abholung bereit", null, slots(3))).toBe(
      "at_pickup_point",
    );
    expect(accountStatus("Geliefert am: 09.10.", 6, null)).toBe("delivered");
    expect(accountStatus("Zustellversuch nicht erfolgreich", null, null)).toBe("problem");
    expect(accountStatus("something new", null, null)).toBeNull();
  });

  it("gives yearless days their year and keeps them in order", () => {
    const today = { year: 2026, month: 1, day: 3 };
    expect(inferYears(["30.12.", "02.01.", "-", "31.02."], today)).toEqual([
      { year: 2025, month: 12, day: 30 },
      { year: 2026, month: 1, day: 2 },
      null,
      null,
    ]);
    expect(localIso({ year: 2026, month: 7, day: 1 })).toBe("2026-07-01T00:00:00+02:00");
  });
});

describe("DPD Germany public tracking", () => {
  const TRACK = (code: string) => `GET tracking.dpd.de/rest/plc/de_DE/${code}`;

  it("maps the current step and the scans", async () => {
    const fake = new FakeDpd()
      .on(
        TRACK(BARCODE_IN),
        json(
          lifeCycle(
            [
              { status: "ACCEPTED", reached: true },
              { status: "ON_THE_ROAD", reached: true },
              { status: "DELIVERED", reached: true, current: true },
            ],
            [
              { date: "2026-11-17T08:00:00", code: "ENA", text: "Paketinfo an DPD übergeben" },
              { date: "2026-11-18T10:30:00", code: "DEY", text: "Paket zugestellt" },
            ],
          ),
        ),
      )
      .on(TRACK(BARCODE_IN2), new Response("", { status: 404 }));
    const { ctx } = context(fake);

    const result = await track(ctx, [BARCODE_IN, BARCODE_IN2, "not-a-dpd-code"]);

    expect(fake.requests).toEqual([TRACK(BARCODE_IN), TRACK(BARCODE_IN2)]);
    expect(result.complete).toBe(true);
    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]).toMatchObject({
      barcode: BARCODE_IN,
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T10:30:00+01:00",
      url: `https://tracking.dpd.de/status/de_DE/parcel/${BARCODE_IN}`,
    });
    expect(result.snapshots[0]?.history.map((event) => event.status)).toEqual([
      "registered",
      "delivered",
    ]);
  });

  it("reports unknown steps instead of guessing", async () => {
    const fake = new FakeDpd().on(
      TRACK(BARCODE_IN),
      json(lifeCycle([{ status: "SOMETHING_NEW", reached: true, current: true }], [])),
    );
    const { ctx, unknowns } = context(fake);
    const result = await track(ctx, [BARCODE_IN]);
    expect(result.snapshots[0]?.status).toBeNull();
    expect(unknowns).toContain("tracking_step=SOMETHING_NEW");
  });

  it("sends nothing when the public page is switched off for the source", async () => {
    const fake = new FakeDpd();
    const result = await track(context(fake, { publicTracking: false }).ctx, [BARCODE_IN]);
    expect(fake.requests).toEqual([]);
    expect(result).toEqual({ snapshots: [], complete: false });
  });

  it("treats an unexpected shape as a transient failure", async () => {
    const fake = new FakeDpd().on(TRACK(BARCODE_IN), json({ something: "else" }));
    await expect(track(context(fake).ctx, [BARCODE_IN])).rejects.toBeInstanceOf(TransientError);
  });

  it("says which expectation broke, without the code", async () => {
    const failure = async (response: Response): Promise<string> => {
      const fake = new FakeDpd().on(TRACK(BARCODE_IN), response);
      const error = await track(context(fake).ctx, [BARCODE_IN]).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransientError);
      const message = (error as Error).message;
      expect(message).not.toContain(BARCODE_IN);
      return message;
    };
    expect(
      await failure(
        new Response("<html>blocked</html>", {
          status: 403,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).toBe("DPD tracking answered HTTP 403 (text/html), expected 200 or 404.");
    expect(
      await failure(
        new Response("<html>a page</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    ).toMatch(/HTTP 200 with text\/html that is not JSON \(\d+ bytes, an HTML page\)/);
    expect(await failure(json({ parcellifecycleResponse: "nope", other: 1 }))).toMatch(
      /unexpected shape \(parcellifecycleResponse: invalid_type\); top-level keys: parcellifecycleResponse, other/,
    );
  });
});
