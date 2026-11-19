import { describe, expect, it } from "vitest";
import { ups } from "../../src/carriers/ups/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { html, json, madeUp, on, World, type Answer, type Route } from "./harness.js";

// Made-up tracking numbers, cookies and keys only.
const CODE = "1Z999AA10000000001";
const OTHER = "1Z999AA10000000002";
const THIRD = "1Z999AA10000000003";
const SECRET = { clientId: madeUp("client"), clientSecret: madeUp("app") };

const PUBLIC = "webapis.ups.com/track/api/Track/GetStatus";
const BOOT = `GET ${PUBLIC}`;
const LOOKUP = `POST ${PUBLIC}`;
const TOKEN = "POST onlinetools.ups.com/security/v1/oauth/token";
const OFFICIAL = (code: string) => `GET onlinetools.ups.com/api/track/v1/details/${code}`;

const SIX_MINUTES = 6 * 60_000;
const HOURS = (n: number) => n * 3_600_000;

const seeded = (): Response =>
  html("<html>app</html>", 200, {
    "set-cookie": "X-XSRF-TOKEN-ST=made-up-csrf; Path=/; Secure",
  });

function detail(extra: Record<string, unknown> = {}) {
  return {
    trackDetails: [
      {
        trackingNumber: CODE,
        currentMilestone: { nameKey: "cms.stapp.inTransit" },
        isDelivered: false,
        sdd: "20261120",
        sdst: "09:00:00",
        sdt: "13:00:00",
        shipmentGMTInfo: { shipToGMTOffset: "+01:00" },
        additionalInformation: { weight: "2.00", weightUnit: "LBS" },
        shipToAddress: { city: "MADE-UP CITY" },
        shipmentProgressActivities: [
          { gmtDate: "20261118", gmtTime: "08:00:00", actCode: "AR", location: "EXAMPLEVILLE" },
          {
            gmtDate: "20261117",
            gmtTime: "18:00:00",
            milestoneName: { nameKey: "cms.stapp.orderReceived" },
          },
        ],
        ...extra,
      },
    ],
  };
}

const hang = (): Error => new DOMException("The operation timed out.", "TimeoutError");

function world(routes: Route[] = []): World {
  return new World(ups, routes);
}

/** Runs track and returns the error it threw, or null. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe("UPS public tracking", () => {
  it("starts a session, sends its CSRF cookie back and reads status, window, weight and history", async () => {
    const w = world([on(BOOT, seeded()), on(LOOKUP, json(detail()))]);
    const result = await w.track([CODE]);
    expect(w.requests()).toEqual([BOOT, LOOKUP]);
    const lookup = w.calls[1];
    expect(lookup?.headers.get("x-xsrf-token")).toBe("made-up-csrf");
    expect(lookup?.headers.get("cookie")).toContain("X-XSRF-TOKEN-ST=made-up-csrf");
    expect(lookup?.headers.get("user-agent")).toContain("Chrome/");
    expect(lookup?.headers.get("sec-ch-ua-platform")).toBe('"macOS"');
    expect(JSON.parse(lookup?.body ?? "{}")).toMatchObject({ TrackingNumber: [CODE] });
    expect(result.complete).toBe(true);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "ups",
      barcode: CODE,
      status: "in_transit",
      rawStatus: "cms.stapp.inTransit",
      plannedFrom: "2026-11-20T08:00:00.000Z",
      plannedTo: "2026-11-20T12:00:00.000Z",
      weightKg: 0.907,
      url: `https://www.ups.com/track?loc=en_US&tracknum=${CODE}`,
    });
    expect(result.snapshots[0]?.history).toEqual([
      {
        at: "2026-11-17T18:00:00.000Z",
        status: "registered",
        rawStatus: "cms.stapp.orderReceived",
        location: null,
      },
      {
        at: "2026-11-18T08:00:00.000Z",
        status: "in_transit",
        rawStatus: "AR",
        location: "EXAMPLEVILLE",
      },
    ]);
    expect(JSON.stringify(result.snapshots[0]?.raw)).not.toContain("MADE-UP CITY");
    expect(w.unknown).toEqual([]);
  });

  it("files a pasted code under its own spelling, the normalised one kept as reference", async () => {
    const pasted = "1z999aa1 0000000001";
    const w = world([on(BOOT, seeded()), on(LOOKUP, json(detail()))]);
    const [parcel] = (await w.track([pasted])).snapshots;
    expect(parcel).toMatchObject({ barcode: pasted, externalRef: CODE });
  });

  it("treats error code 504 as not found", async () => {
    const notFound = { trackDetails: [{ errorCode: "504", errorText: "not found" }] };
    const w = world([on(BOOT, seeded()), on(LOOKUP, json(notFound))]);
    expect(await w.track([CODE])).toEqual({ snapshots: [], complete: true });
  });

  it("reports a milestone and a scan code it does not know, but not a deliberately quiet one", async () => {
    const body = detail({
      currentMilestone: { nameKey: "cms.stapp.somethingNew" },
      shipmentProgressActivities: [
        { gmtDate: "20261118", gmtTime: "08:00:00", actCode: "QQ" },
        { gmtDate: "20261118", gmtTime: "07:00:00", actCode: "CG" },
      ],
    });
    const w = world([on(BOOT, seeded()), on(LOOKUP, json(body))]);
    const [parcel] = (await w.track([CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(parcel?.rawStatus).toBe("cms.stapp.somethingNew");
    expect(w.unknown).toEqual(["milestone_code:cms.stapp.somethingNew", "scan_code:QQ"]);
  });

  it("asks one code per run, keeps a gap between runs and stops quietly once the budget is spent", async () => {
    const lookups: Answer[] = [json(detail()), json(detail()), json(detail()), json(detail())];
    const w = world([on(BOOT, seeded()), on(LOOKUP, ...lookups)]);
    const codes = [CODE, OTHER, THIRD];

    const first = await w.track(codes);
    expect(first.complete).toBe(false);
    // Too soon after the first lookup: nothing is sent, and nothing fails.
    w.clock.advance(60_000);
    expect(await w.track(codes)).toEqual({ snapshots: [], complete: false });
    expect(w.requests()).toEqual([BOOT, LOOKUP]);

    for (let run = 0; run < 2; run += 1) {
      w.clock.advance(SIX_MINUTES);
      await w.track(codes);
    }
    const asked = w.calls
      .filter((c) => c.method === "POST")
      .map((c) => (JSON.parse(c.body ?? "{}") as { TrackingNumber: string[] }).TrackingNumber[0]);
    // Never-asked codes go first, so each code had a turn.
    expect(asked).toEqual(codes);

    // Three requests spent: the fourth run sends nothing and resolves without an error.
    w.clock.advance(SIX_MINUTES);
    const sent = w.calls.length;
    expect(await w.track(codes)).toEqual({ snapshots: [], complete: false });
    expect(w.calls).toHaveLength(sent);

    // One token comes back after 75 minutes.
    w.clock.advance(HOURS(1.25));
    await w.track(codes);
    expect(w.calls).toHaveLength(sent + 1);
  });

  it("treats a hanging lookup as a transient bot-guard refusal, empties the budget and stands down", async () => {
    const w = world([on(BOOT, seeded()), on(LOOKUP, hang(), json(detail()))]);
    const error = await failure(w.track([CODE]));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(SignInRejectedError);
    expect((error as Error).name).toBe("BotGuardError");
    expect(w.stored).toMatchObject({ failures: 1, budget: { tokens: 0 } });

    // Standing down: later runs inside the stand-down send nothing and do not fail.
    w.clock.advance(HOURS(1.5));
    const sent = w.calls.length;
    expect(await w.track([CODE])).toEqual({ snapshots: [], complete: false });
    expect(w.calls).toHaveLength(sent);

    // After two hours the address is asked again, and a success clears the stand-down.
    w.clock.advance(HOURS(0.6));
    expect((await w.track([CODE])).snapshots).toHaveLength(1);
    expect(w.stored).toMatchObject({ failures: 0, standdownUntil: null });
  });

  it("sends no lookup when the session start answers with a challenge page", async () => {
    const w = world([on(BOOT, html("<html>challenge</html>"))]);
    const error = await failure(w.track([CODE]));
    expect(error).toBeInstanceOf(TransientError);
    expect(w.requests()).toEqual([BOOT]);
    // Something answered, so the allowance is not thrown away; only a hang empties it.
    expect(w.stored).toMatchObject({ failures: 1, budget: { tokens: 2 } });
  });

  it("starts a new session once on a 401 and charges the second request", async () => {
    const w = world([on(BOOT, seeded(), seeded()), on(LOOKUP, json({}, 401), json(detail()))]);
    expect((await w.track([CODE])).snapshots).toHaveLength(1);
    expect(w.requests()).toEqual([BOOT, LOOKUP, BOOT, LOOKUP]);
    expect(w.stored).toMatchObject({ budget: { tokens: 1 } });
  });
});

function officialPackage(type: string, at: string) {
  return {
    trackResponse: {
      shipment: [
        {
          package: [
            {
              trackingNumber: CODE,
              currentStatus: { description: "Official status", code: "SR" },
              weight: { unitOfMeasurement: "KGS", weight: "1.50" },
              activity: [
                {
                  status: { type, description: `Official ${type}`, code: "XX" },
                  gmtDate: at.slice(0, 8),
                  gmtTime: at.slice(8),
                  location: { address: { city: "TESTCITY" } },
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

const token = (value: string): Response =>
  json({ access_token: value, expires_in: "14399", token_type: "Bearer" });

describe("UPS official Tracking API", () => {
  it("merges both back ends: the newest scan decides, details fill in, histories join", async () => {
    const w = world([
      on(TOKEN, token("t1")),
      on(OFFICIAL(CODE), json(officialPackage("D", "2026111810:30:00"))),
      on(BOOT, seeded()),
      on(LOOKUP, json(detail())),
    ]);
    const result = await w.track([CODE], {}, SECRET);
    expect(w.requests()).toEqual([TOKEN, OFFICIAL(CODE), BOOT, LOOKUP]);
    expect(w.calls[0]?.headers.get("authorization")).toMatch(/^Basic /);
    expect(w.calls[1]?.headers.get("authorization")).toBe("Bearer t1");
    expect(w.calls[1]?.headers.get("user-agent")).toContain("open-parcels");
    expect(result.complete).toBe(true);
    const [merged] = result.snapshots;
    expect(merged).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T10:30:00.000Z",
      plannedFrom: null,
      weightKg: 1.5,
    });
    expect(merged?.history.map((e) => e.rawStatus)).toEqual([
      "cms.stapp.orderReceived",
      "AR",
      "Official D",
    ]);
    expect(Object.keys(merged?.raw as object).sort()).toEqual(["official", "public"]);
  });

  it("takes the package asked for from a multi-package shipment, never simply the first", async () => {
    const answer = officialPackage("I", "2026111810:30:00");
    const [shipment] = answer.trackResponse.shipment;
    const [asked] = shipment?.package ?? [];
    if (shipment === undefined || asked === undefined) {
      throw new Error("fixture");
    }
    shipment.package = [
      { ...asked, trackingNumber: OTHER, currentStatus: { description: "x", code: "D" } },
      asked,
    ];
    const w = world([
      on(TOKEN, token("t1")),
      on(OFFICIAL(CODE), json(answer)),
      on(BOOT, seeded()),
      on(LOOKUP, hang()),
    ]);
    const [parcel] = (await w.track([CODE], {}, SECRET)).snapshots;
    expect(parcel?.status).toBe("in_transit");
  });

  it("keeps the official answers when the public tracking fails", async () => {
    const w = world([
      on(TOKEN, token("t1")),
      on(OFFICIAL(CODE), json(officialPackage("I", "2026111810:30:00"))),
      on(BOOT, seeded()),
      on(LOOKUP, hang()),
    ]);
    const result = await w.track([CODE], {}, SECRET);
    expect(result.snapshots[0]?.status).toBe("in_transit");
    expect(w.warnings).toHaveLength(1);
  });

  it("asks for a new sign-in when UPS refuses the key", async () => {
    const w = world([on(TOKEN, json({ response: { errors: [] } }, 401))]);
    expect(await failure(w.track([CODE], {}, SECRET))).toBeInstanceOf(SignInRejectedError);
    expect(w.requests()).toEqual([TOKEN]);
  });

  it("requests a new token once when the stored one is refused", async () => {
    const w = world([
      on(TOKEN, token("t1"), token("t2")),
      on(OFFICIAL(CODE), json({}, 401), json(officialPackage("I", "2026111810:30:00"))),
      on(BOOT, seeded()),
      on(LOOKUP, json(detail())),
    ]);
    await w.track([CODE], {}, SECRET);
    expect(w.requests().slice(0, 4)).toEqual([TOKEN, OFFICIAL(CODE), TOKEN, OFFICIAL(CODE)]);
    expect(w.calls[3]?.headers.get("authorization")).toBe("Bearer t2");
  });

  it("requests a new token at most once per run, not once per code", async () => {
    const w = world([
      on(TOKEN, token("t1"), token("t2"), token("t3")),
      on(OFFICIAL(CODE), json({}, 401), json(officialPackage("I", "2026111810:30:00"))),
      on(OFFICIAL(OTHER), json({}, 401)),
    ]);
    expect(await failure(w.track([CODE, OTHER], {}, SECRET))).toBeInstanceOf(SignInRejectedError);
    expect(w.requests().filter((request) => request === TOKEN)).toHaveLength(2);
  });

  it("never requests a new token on a network error", async () => {
    const w = world([
      on(TOKEN, token("t1"), token("t2")),
      on(OFFICIAL(CODE), new Error("socket hang up")),
    ]);
    const error = await failure(w.track([CODE], {}, SECRET));
    expect(error).toBeInstanceOf(TransientError);
    expect(error).not.toBeInstanceOf(SignInRejectedError);
    expect(w.requests()).toEqual([TOKEN, OFFICIAL(CODE)]);
  });

  it("treats a 404 as not found", async () => {
    const w = world([
      on(TOKEN, token("t1")),
      on(OFFICIAL(CODE), json({ response: { errors: [{ code: "151018" }] } }, 404)),
      on(BOOT, seeded()),
      on(LOOKUP, json({ trackDetails: [{ errorCode: "504" }] })),
    ]);
    expect(await w.track([CODE], {}, SECRET)).toEqual({ snapshots: [], complete: true });
  });
});
