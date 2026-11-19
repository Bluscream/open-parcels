import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeParcel, type ParcelState } from "../../src/engine/merge.js";
import { fingerprint } from "../../src/engine/reconciler.js";
import { rewriteOffsetTimes } from "../../src/engine/utc-repair.js";
import { toUtc } from "../../src/engine/utc.js";
import { FakeWorld, fakePost, scan, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Times with an offset against UTC times. Every code is made up. */

const STORED: ParcelState = {
  direction: "incoming",
  status: "out_for_delivery",
  rawStatus: "Out for delivery",
  statusAt: "2026-11-18T14:00:00.000Z",
  delivered: false,
  deliveredAt: null,
  plannedFrom: null,
  plannedTo: null,
  pickup: false,
  pickupPoint: null,
  url: null,
  sender: null,
  receiver: null,
  weightKg: null,
};

describe("times with an offset", () => {
  it("are canonical UTC once normalised; dates and unreadable text stay as they are", () => {
    expect(toUtc("2026-11-18T14:30:00+01:00")).toBe("2026-11-18T13:30:00.000Z");
    expect(toUtc("2026-11-18T14:30:00Z")).toBe("2026-11-18T14:30:00.000Z");
    expect(toUtc("2026-11-18")).toBe("2026-11-18");
    expect(toUtc("soon")).toBe("soon");
  });

  it("never let an older scan with an offset take a newer UTC status back", () => {
    const older = snapshot({
      carrier: "fakepost",
      barcode: "FP9001",
      status: "in_transit",
      rawStatus: "Moving",
      // 13:30 UTC, half an hour before the stored scan, though it sorts after it as text.
      history: [scan("2026-11-18T14:30:00+01:00", "Moving", "in_transit")],
    });
    expect(mergeParcel(STORED, older, "carrier").status).toBe("out_for_delivery");
    expect(mergeParcel(STORED, older, "secondary").status).toBe("out_for_delivery");
  });
});

describe("stored times", () => {
  let context: TestContext;
  let post: FakeWorld;

  beforeEach(async () => {
    post = new FakeWorld();
    context = await createTestContext({ plugins: [fakePost(post)] });
  });
  afterEach(async () => {
    await context.close();
  });

  it("are written as UTC whatever offset the plug-in sent", async () => {
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP9002",
        status: "delivered",
        rawStatus: "Delivered",
        deliveredAt: "2026-11-18T10:30:00+01:00",
        history: [scan("2026-11-18T10:30:00+01:00", "Delivered", "delivered")],
      }),
    ];
    const source = await context.services.sources.create({
      plugin: "fakepost",
      kind: "account",
      label: "account",
      config: {},
      secret: { username: "user@example.invalid", password: ["p", "q"].join("-") },
    });
    await context.services.runner.run(source.id);
    const parcel = await context.services.db
      .selectFrom("parcels")
      .select(["status_at", "delivered_at"])
      .executeTakeFirstOrThrow();
    expect(parcel).toEqual({
      status_at: "2026-11-18T09:30:00.000Z",
      delivered_at: "2026-11-18T09:30:00.000Z",
    });
    const events = await context.services.db.selectFrom("parcel_events").select("at").execute();
    expect(events).toEqual([{ at: "2026-11-18T09:30:00.000Z" }]);
  });

  it("are rewritten as UTC at startup, keeping history entries unique", async () => {
    const now = context.clock.now().toISOString();
    const id = "00000000-0000-4000-8000-000000000091";
    await context.services.db
      .insertInto("parcels")
      .values({
        id,
        carrier: "fakepost",
        barcode: "FP9003",
        direction: "incoming",
        status: "in_transit",
        raw_status: "Moving",
        status_at: "2026-11-18T14:30:00+01:00",
        delivered: 0,
        planned_from: "2026-11-19T08:00:00+01:00",
        planned_to: "2026-11-19T12:00:00Z",
        pickup: 0,
        label: null,
        first_seen_at: now,
        last_seen_at: now,
        updated_at: now,
      })
      .execute();
    const entry = (at: string) => ({
      parcel_id: id,
      source_id: null,
      at,
      status: "in_transit",
      raw_status: "Moving",
      location_text: null,
      fingerprint: fingerprint({ at, rawStatus: "Moving", location: null }),
    });
    // The same scan stored twice by an older version: once with its offset, once in UTC.
    await context.services.db
      .insertInto("parcel_events")
      .values([entry("2026-11-18T14:30:00+01:00"), entry("2026-11-18T13:30:00.000Z")])
      .execute();

    expect(await rewriteOffsetTimes(context.services.db)).toBe(4);
    expect(await rewriteOffsetTimes(context.services.db)).toBe(0);

    const parcel = await context.services.db
      .selectFrom("parcels")
      .select(["status_at", "planned_from", "planned_to"])
      .executeTakeFirstOrThrow();
    expect(parcel).toEqual({
      status_at: "2026-11-18T13:30:00.000Z",
      planned_from: "2026-11-19T07:00:00.000Z",
      planned_to: "2026-11-19T12:00:00.000Z",
    });
    const events = await context.services.db
      .selectFrom("parcel_events")
      .select(["at", "fingerprint"])
      .execute();
    expect(events).toEqual([
      {
        at: "2026-11-18T13:30:00.000Z",
        fingerprint: fingerprint({
          at: "2026-11-18T13:30:00.000Z",
          rawStatus: "Moving",
          location: null,
        }),
      },
    ]);
  });
});
