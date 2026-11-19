import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignInRejectedError, RateLimitedError, TransientError } from "../../src/plugin/api.js";
import { createTestContext, type TestContext } from "../helpers.js";
import { FakeWorld, fakePost, fakeShop, scan, snapshot } from "../fakes/carriers.js";

const HOUR = 3_600_000;
const MINUTE = 60_000;

let context: TestContext;
let post: FakeWorld;
let shop: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  shop = new FakeWorld();
  context = await createTestContext({ plugins: [fakePost(post), fakeShop(shop)] });
});
afterEach(async () => {
  await context.close();
});

async function addAccount(): Promise<string> {
  const source = await context.services.sources.create({
    plugin: "fakepost",
    kind: "account",
    label: "Fake account",
    config: {},
    secret: { username: "user@example.invalid", password: ["made", "up"].join("-") },
  });
  return source.id;
}

async function addShop(): Promise<string> {
  const source = await context.services.sources.create({
    plugin: "fakeshop",
    kind: "shop",
    label: "Shop",
    config: {},
    secret: null,
  });
  return source.id;
}

/** Events in order, without the `source.run_finished` every run ends with. */
async function eventTypes(): Promise<string[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select("type")
    .where("type", "!=", "source.run_finished")
    .orderBy("seq")
    .execute();
  return rows.map((row) => row.type);
}

async function sourceRow(id: string) {
  return context.services.db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function runNow(id: string): Promise<void> {
  await context.services.sources.requestRun(id);
  await context.services.scheduler.runDue();
}

describe("first sync", () => {
  it("stores parcels with history and announces only undelivered ones", async () => {
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
        history: [
          scan("2026-11-17T08:00:00Z", "Accepted", "registered"),
          scan("2026-11-18T07:00:00Z", "On its way", "in_transit", "Hub Example"),
        ],
      }),
      snapshot({
        carrier: "fakepost",
        barcode: "FP0002",
        status: "delivered",
        rawStatus: "Delivered",
        deliveredAt: "2026-11-10T12:00:00Z",
      }),
    ];
    const id = await addAccount();
    await context.services.scheduler.runDue();

    const parcels = await context.services.parcels.repository.list({}, true);
    expect(parcels).toHaveLength(2);
    const active = parcels.find((parcel) => parcel.barcode === "FP0001");
    expect(active?.history.map((entry) => entry.raw_status)).toEqual(["Accepted", "On its way"]);
    expect(active?.sources[0]).toMatchObject({ plugin: "fakepost", role: "primary" });
    expect(await eventTypes()).toEqual(["parcel.registered"]);

    // Re-running with the same data writes no duplicate history and no new events.
    await runNow(id);
    const again = await context.services.parcels.repository.get(active?.id ?? "");
    expect(again?.history).toHaveLength(2);
    expect(await eventTypes()).toEqual(["parcel.registered"]);
  });
});

describe("event rules", () => {
  it("fires status_changed, delivery_time_changed and only delivered on the final hop", async () => {
    const id = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    await runNow(id);

    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "out_for_delivery",
        rawStatus: "Out for delivery",
        plannedFrom: "2026-11-18T15:00:00Z",
        plannedTo: "2026-11-18T18:00:00Z",
      }),
    ];
    await runNow(id);
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "delivered",
        rawStatus: "Delivered",
        deliveredAt: "2026-11-18T16:05:00Z",
      }),
    ];
    await runNow(id);

    expect(await eventTypes()).toEqual([
      "parcel.registered",
      "parcel.status_changed",
      "parcel.delivery_time_changed",
      "parcel.delivered",
    ]);
    const parcel = (await context.services.parcels.repository.list({}, false))[0];
    expect(parcel).toMatchObject({
      delivered: true,
      planned_from: null,
      planned_to: null,
      delivered_at: "2026-11-18T16:05:00.000Z",
    });
  });

  it("never lets carrier updates override a manual status", async () => {
    const id = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    await runNow(id);
    const parcelId = (await context.services.parcels.repository.list({}, false))[0]?.id ?? "";
    await context.services.parcels.update(parcelId, { manualStatus: "delivered" });
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "out_for_delivery",
        rawStatus: "Out for delivery",
      }),
    ];
    await runNow(id);
    const parcel = await context.services.parcels.repository.get(parcelId);
    // The effective values win; what the carrier said stays available beside them.
    expect(parcel).toMatchObject({
      manual_status: "delivered",
      status: "delivered",
      delivered: true,
      carrier_status: "out_for_delivery",
      carrier_delivered: false,
    });
    expect(await eventTypes()).toEqual(["parcel.registered", "parcel.delivered"]);
    expect(await context.services.parcels.repository.list({ active: true }, false)).toEqual([]);
  });

  it("falls back to the newest mapped history entry for an unknown status and reports it once", async () => {
    const id = await addAccount();
    post.unknownToReport = ["X42"];
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: null,
        rawStatus: "Mystery code X42",
        history: [
          scan("2026-11-18T07:00:00Z", "Sorted", "in_transit"),
          scan("2026-11-18T08:00:00Z", "Mystery code X42", null),
        ],
      }),
    ];
    await runNow(id);
    await runNow(id);
    const parcel = (await context.services.parcels.repository.list({}, false))[0];
    expect(parcel?.status).toBe("in_transit");
    expect((await eventTypes()).filter((type) => type === "vocab.unknown")).toHaveLength(1);
    const vocab = await context.services.db.selectFrom("unknown_vocab").selectAll().execute();
    expect(vocab).toEqual([
      expect.objectContaining({ plugin: "fakepost", kind: "status_code", key: "X42", count: 2 }),
    ]);
  });
});

describe("hand-off between a shop and a carrier", () => {
  it("folds the shop's own entry into the carrier parcel, so there is never a duplicate", async () => {
    const shopId = await addShop();
    const order = {
      shop: "fakeshop",
      orderNumber: "000-0000000-0000001",
      placedAt: "2026-11-15T10:00:00Z",
    };
    const item = {
      title: "Example widget",
      imageUrl: "https://images.example.invalid/w.jpg",
      url: null,
      externalId: "B000000000",
      quantity: 1,
      price: null,
      currency: null,
    };
    shop.listing = [
      snapshot({
        carrier: "fakeshop",
        barcode: "SHOP-1",
        status: "registered",
        rawStatus: "Ordered",
        order,
        items: [item],
      }),
    ];
    await runNow(shopId);
    expect(await context.services.parcels.repository.list({}, false)).toHaveLength(1);

    shop.listing = [
      snapshot({
        carrier: "fakeshop",
        barcode: "SHOP-1",
        status: "in_transit",
        rawStatus: "Shipped",
        order,
        items: [item],
        handoff: { carrier: "fakepost", barcode: "FP0009" },
      }),
    ];
    await runNow(shopId);
    const accountId = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0009",
        status: "out_for_delivery",
        rawStatus: "Out for delivery",
        history: [scan("2026-11-18T09:00:00Z", "Out for delivery", "out_for_delivery")],
      }),
    ];
    await runNow(accountId);

    const parcels = await context.services.parcels.repository.list({}, false);
    expect(parcels).toHaveLength(1);
    expect(parcels[0]).toMatchObject({
      carrier: "fakepost",
      barcode: "FP0009",
      status: "out_for_delivery",
      order: { shop: "fakeshop" },
      items: [{ title: "Example widget" }],
    });
    // Pictures are served through the image proxy; the remote address never reaches clients or events.
    expect(parcels[0]?.items[0]?.image_url).toMatch(/^\/img\/[\w-]+\.[\w-]{32}$/);
    const outbox = await context.services.db.selectFrom("outbox").select("payload").execute();
    expect(JSON.stringify(outbox)).not.toContain("images.example.invalid");
    expect(parcels[0]?.sources.map((source) => source.role).sort()).toEqual(["handoff", "primary"]);
  });

  it("does not let the shop's older view overwrite the carrier's newer scan", async () => {
    const accountId = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0009",
        status: "out_for_delivery",
        rawStatus: "Out for delivery",
        history: [scan("2026-11-18T09:00:00Z", "Out for delivery", "out_for_delivery")],
      }),
    ];
    await runNow(accountId);
    const shopId = await addShop();
    shop.listing = [
      snapshot({
        carrier: "fakeshop",
        barcode: "SHOP-1",
        status: "in_transit",
        rawStatus: "Shipped",
        history: [scan("2026-11-17T09:00:00Z", "Shipped", "in_transit")],
        handoff: { carrier: "fakepost", barcode: "FP0009" },
      }),
    ];
    await runNow(shopId);
    expect((await context.services.parcels.repository.list({}, false))[0]?.status).toBe(
      "out_for_delivery",
    );
  });
});

describe("parcel.removed", () => {
  it("fires once after six hours missing from every complete listing", async () => {
    const id = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    await runNow(id);
    post.listing = [];
    await runNow(id);
    context.clock.advance(5 * HOUR);
    expect(await context.services.reconciler.judgeRemovals()).toBe(0);
    context.clock.advance(HOUR + MINUTE);
    expect(await context.services.reconciler.judgeRemovals()).toBe(1);
    expect(await context.services.reconciler.judgeRemovals()).toBe(0);
    expect((await eventTypes()).filter((type) => type === "parcel.removed")).toHaveLength(1);
  });

  it("judges nothing while the source is failing, and forgets the absence when the parcel returns", async () => {
    const id = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    await runNow(id);
    post.listing = [];
    await runNow(id);
    post.failWith = new TransientError("network down");
    await runNow(id);
    context.clock.advance(7 * HOUR);
    expect(await context.services.reconciler.judgeRemovals()).toBe(0);

    post.failWith = undefined;
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    await runNow(id);
    context.clock.advance(7 * HOUR);
    expect(await context.services.reconciler.judgeRemovals()).toBe(0);
  });

  it("does not judge partial results", async () => {
    const id = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    await runNow(id);
    post.listing = [];
    post.complete = false;
    await runNow(id);
    context.clock.advance(7 * HOUR);
    expect(await context.services.reconciler.judgeRemovals()).toBe(0);
  });
});

describe("scheduler", () => {
  it("schedules the next run from the parcels in flight", async () => {
    const id = await addAccount();
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0001",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    const ran = await context.services.scheduler.runDue();
    expect(ran).toBe(1);
    const row = await sourceRow(id);
    const delay = Date.parse(row.next_run_at ?? "") - context.clock.now().getTime();
    expect(delay).toBeGreaterThanOrEqual(45 * MINUTE);
    expect(delay).toBeLessThanOrEqual(51 * MINUTE);
    expect(await context.services.scheduler.runDue()).toBe(0);
  });

  it("backs off on transient errors and honours Retry-After", async () => {
    const id = await addAccount();
    post.failWith = new TransientError("timeout");
    await context.services.scheduler.runDue();
    let row = await sourceRow(id);
    expect(row).toMatchObject({ state: "error", consecutive_failures: 1 });
    expect(Date.parse(row.next_run_at ?? "") - context.clock.now().getTime()).toBe(5 * MINUTE);

    post.failWith = new RateLimitedError("slow down", 900);
    await runNow(id);
    row = await sourceRow(id);
    expect(Date.parse(row.next_run_at ?? "") - context.clock.now().getTime()).toBe(900_000);

    post.failWith = undefined;
    await runNow(id);
    row = await sourceRow(id);
    expect(row).toMatchObject({ state: "ok", consecutive_failures: 0 });
    expect((await eventTypes()).filter((type) => type === "source.state_changed")).toHaveLength(2);
  });

  it("stops and asks for a new sign-in when the carrier rejects it, without retrying", async () => {
    const id = await addAccount();
    post.failWith = new SignInRejectedError("bad credentials");
    await context.services.scheduler.runDue();
    const row = await sourceRow(id);
    expect(row).toMatchObject({ state: "needs_sign_in", next_run_at: null });
    context.clock.advance(24 * HOUR);
    expect(await context.services.scheduler.runDue()).toBe(0);
    expect(post.accountCalls).toHaveLength(1);
  });

  it("keeps the carrier's renewed session encrypted and hands it back on the next run", async () => {
    const id = await addAccount();
    await runNow(id);
    await runNow(id);
    expect(post.sessions).toEqual([undefined, { token: "renewed-1" }]);
    const row = await sourceRow(id);
    expect(row.session_blob?.toString("utf8") ?? "").not.toContain("renewed");
    expect(row.secret_blob?.toString("utf8") ?? "").not.toContain("example.invalid");
  });

  it("tracks codes added by hand through the carrier's tracking source", async () => {
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0777",
        status: "in_transit",
        rawStatus: "On its way",
      }),
    ];
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      barcode: "FP0777",
      direction: "incoming",
      label: null,
    });
    await context.services.scheduler.runDue();
    expect(post.trackCalls).toEqual([["FP0777"]]);
    expect((await context.services.parcels.repository.get(parcel.id))?.status).toBe("in_transit");
  });

  it("stops polling a tracking source when nothing is active", async () => {
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0777",
        status: "delivered",
        rawStatus: "Delivered",
      }),
    ];
    await context.services.parcels.create({
      carrier: "fakepost",
      barcode: "FP0777",
      direction: "incoming",
      label: null,
    });
    await context.services.scheduler.runDue();
    const tracking = (await context.services.sources.list()).find(
      (source) => source.kind === "tracking",
    );
    expect(tracking?.nextRunAt).toBeNull();
  });
});
