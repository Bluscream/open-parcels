import { createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appHeaders, portalPhoneKey } from "../../src/carriers/cargus/shared.js";
import { cargus } from "../../src/carriers/cargus/index.js";
import { carrierKey } from "../../src/plugin/rules.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, madeUp, on, raw, World } from "./harness.js";

// Made-up AWBs, phone numbers, tokens and accounts only.
const AWB = "1000000001";
const TRACE = "GET cmacwabackend.azurewebsites.net/api/Awbs/ShortTrace";
const LIST = "GET cmacwabackend.azurewebsites.net/api/Awbs/AwbList";
const TOKEN =
  "POST mycargus.b2clogin.com/myCargus.onmicrosoft.com/B2C_1A_ACCOUNTLINK_SUSI_WEB/oauth2/v2.0/token";
const SECRET = { username: "user@example.com", password: madeUp("pass") };
const CONFIG = { phone: "+40 700 000 000" };

const trace = (events: { date: string; event: string }[], statusMessage = "In warehouse") => ({
  awbBarcode: AWB,
  statusMessage,
  events,
});

describe("Cargus request headers", () => {
  it("encrypts the message under the app key with the IV sent as seed", () => {
    const headers = appHeaders("hello");
    const key = Buffer.from(carrierKey("cargus", "header_key"), "hex");
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(headers.seed, "hex"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(headers.k, "base64")),
      decipher.final(),
    ]).toString();
    expect(plain).toBe("hello");
    expect(headers.s).toBe("M");
  });

  it("hides the phone digits among noise in the portal key", () => {
    const key = portalPhoneKey("+40700000000");
    expect(key.length).toBeGreaterThan(60);
    expect(key).not.toContain("40700000000");
  });
});

describe("Cargus tracking", () => {
  it("reads the newest mapped scan in Bucharest time", async () => {
    const world = new World(cargus, [
      on(
        TRACE,
        json(
          trace([
            { date: "2026-11-17T09:00:00", event: "Received in warehouse Testville [Depozit]" },
            { date: "2026-11-18T08:00:00", event: "With courier" },
          ]),
        ),
      ),
    ]);
    const [found] = (await world.track([AWB])).snapshots;
    expect(world.calls[0]?.headers.get("k")).not.toBeNull();
    expect(world.calls[0]?.url.searchParams.get("lang")).toBe("EN");
    expect(found).toMatchObject({
      barcode: AWB,
      status: "out_for_delivery",
      history: [{ at: "2026-11-18T06:00:00.000Z" }, { status: "in_transit" }],
    });
  });

  it("lets a delivered summary win over an unknown newest wording", async () => {
    const world = new World(cargus, [
      on(
        TRACE,
        json(
          trace(
            [
              { date: "2026-11-18T08:00:00", event: "With courier" },
              { date: "2026-11-18T12:00:00", event: "Handed over somehow" },
            ],
            "Delivered",
          ),
        ),
        new Response(null, { status: 204 }),
        raw("", 403),
      ),
    ]);
    expect((await world.track([AWB])).snapshots[0]?.status).toBe("delivered");
    expect(world.unknownKeys).toContain("Handed over somehow");
    expect((await world.track([AWB])).snapshots).toEqual([]);
    await expect(world.track([AWB])).rejects.toBeInstanceOf(TransientError);
  });
});

describe("Cargus account", () => {
  const tokens = { access: "a1", refresh: "r1", expiresAt: Date.parse("2026-11-18T18:00:00Z") };

  it("reads every list once and traces each AWB, with the delivery window", async () => {
    const world = new World(cargus, [
      on(
        LIST,
        json([
          {
            awbBarCode: AWB,
            isSender: false,
            arrivingTimeFrom: "10:00:00",
            arrivingTimeTo: "14:00:00",
            date1: "2026-11-18T00:00:00",
          },
        ]),
        json([]),
        json({ data: [] }),
        new Response(null, { status: 204 }),
        json([]),
      ),
      on(TRACE, json(trace([{ date: "2026-11-18T08:00:00", event: "With courier" }]))),
    ]);
    world.stored = tokens;
    const result = await world.fetchAccount(CONFIG, SECRET);
    expect(world.requests().filter((key) => key === LIST)).toHaveLength(5);
    expect(world.calls[0]?.headers.get("authorization")).toBe("Bearer a1");
    expect(world.calls[0]?.headers.get("k")).not.toBeNull();
    expect(result.snapshots[0]).toMatchObject({
      status: "out_for_delivery",
      direction: "incoming",
      plannedFrom: "2026-11-18T08:00:00.000Z",
      plannedTo: "2026-11-18T12:00:00.000Z",
    });
  });

  it("refreshes an old token and never signs in on a network error", async () => {
    const world = new World(cargus, [on(TOKEN, new TypeError("fetch failed"))]);
    world.stored = { ...tokens, expiresAt: 0 };
    await expect(world.fetchAccount(CONFIG, SECRET)).rejects.toThrow();
    expect(world.requests()).toEqual([TOKEN]);
  });

  it("needs the phone number", async () => {
    const world = new World(cargus, []);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
  });
});
