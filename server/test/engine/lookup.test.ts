import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServices } from "../../src/services.js";
import { applyRetention } from "../../src/engine/retention.js";
import { createTestContext, type TestContext } from "../helpers.js";
import { FakeWorld, fakePost, snapshot } from "../fakes/carriers.js";

const DAY = 24 * 60 * 60 * 1000;
const POLICY = { archiveAfterDays: 30, deleteAfterDays: 365, rawAfterDays: 30 } as const;

let context: TestContext;
let post: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  context = await createTestContext({ plugins: [fakePost(post)] });
});
afterEach(async () => {
  await context.close();
});

async function track(barcode: string): Promise<string> {
  const parcel = await context.services.parcels.create({
    carrier: "fakepost",
    barcode,
    direction: "incoming",
    label: null,
  });
  return parcel.id;
}

async function lookupOf(id: string) {
  return (await context.services.parcels.repository.get(id))?.lookup;
}

describe("carrier lookups", () => {
  it("marks codes the carrier did not return as not found, with when that began", async () => {
    // A tracking answer that is not a complete listing, so the six-hour removal rule stays out.
    post.complete = false;
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP1001",
        status: "in_transit",
        rawStatus: "Moving",
      }),
    ];
    const known = await track("FP1001");
    const unknown = await track("FP1002");
    expect(await lookupOf(unknown)).toEqual({ state: "pending", since: null, checked_at: null });

    await context.services.scheduler.runDue();
    const first = context.clock.now().toISOString();
    expect(await lookupOf(known)).toMatchObject({ state: "found", checked_at: first });
    expect(await lookupOf(unknown)).toEqual({
      state: "not_found",
      since: first,
      checked_at: first,
    });

    // Asked again later: `since` stays, `checked_at` moves.
    context.clock.advance(DAY);
    const [source] = await context.services.sources.list();
    await context.services.sources.requestRun(source?.id ?? "");
    await context.services.scheduler.runDue();
    expect(await lookupOf(unknown)).toMatchObject({
      state: "not_found",
      since: first,
      checked_at: context.clock.now().toISOString(),
    });

    // No event announces a lookup that failed.
    const types = await context.services.db.selectFrom("outbox").select("type").execute();
    expect(types.map((row) => row.type)).not.toContain("parcel.removed");
  });

  it("archives a parcel the carrier has not known for the configured days, unless set by hand", async () => {
    const lost = await track("FP2001");
    const kept = await track("FP2002");
    await context.services.parcels.update(kept, { manualStatus: "in_transit" });
    await context.services.scheduler.runDue();

    const policy = { ...POLICY, notFoundArchiveDays: 30 };
    context.clock.advance(29 * DAY);
    expect(
      (await applyRetention(context.services.db, context.clock, policy)).notFoundArchived,
    ).toBe(0);
    context.clock.advance(2 * DAY);
    expect(
      (await applyRetention(context.services.db, context.clock, policy)).notFoundArchived,
    ).toBe(1);
    const active = await context.services.parcels.repository.list({}, false);
    expect(active.map((parcel) => parcel.id)).toEqual([kept]);
    expect(lost).not.toBe(kept);

    expect(
      (
        await applyRetention(context.services.db, context.clock, {
          ...POLICY,
          notFoundArchiveDays: 0,
        })
      ).notFoundArchived,
    ).toBe(0);
  });
});

describe("startup repair", () => {
  it("links active parcels without a tracking source to their carrier, once", async () => {
    const now = context.clock.now().toISOString();
    const row = (id: string, barcode: string, delivered: 0 | 1) => ({
      id,
      carrier: "fakepost",
      barcode,
      direction: "incoming" as const,
      status: delivered === 1 ? "delivered" : "registered",
      raw_status: null,
      delivered,
      pickup: 0 as const,
      label: null,
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    });
    await context.services.db
      .insertInto("parcels")
      .values([
        row("00000000-0000-4000-8000-000000000001", "FP3001", 0),
        row("00000000-0000-4000-8000-000000000002", "FP3002", 1),
      ])
      .execute();

    const restart = async () =>
      createServices({
        config: context.services.config,
        db: context.services.db,
        logger: context.services.logger,
        clock: context.clock,
        secrets: context.services.secrets,
        plugins: [fakePost(post)],
      });
    await restart();
    await restart();

    const links = await context.services.db
      .selectFrom("parcel_sources")
      .innerJoin("sources", "sources.id", "parcel_sources.source_id")
      .select(["parcel_sources.parcel_id", "sources.kind", "parcel_sources.role"])
      .execute();
    expect(links).toEqual([
      { parcel_id: "00000000-0000-4000-8000-000000000001", kind: "tracking", role: "primary" },
    ]);
  });
});
