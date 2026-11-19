import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeParcel, type ParcelState } from "../../src/engine/merge.js";
import { FakeWorld, fakePost, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Sources whose answers carry no history. Every code is made up. */

const SCANNED: ParcelState = {
  direction: "incoming",
  status: "out_for_delivery",
  rawStatus: "Out for delivery",
  statusAt: "2026-11-18T09:00:00.000Z",
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

const bare = (status: "in_transit" | "delivered") =>
  snapshot({ carrier: "dhl", barcode: "JVGL0000000000000009", status, rawStatus: status });

describe("a source without history", () => {
  it("does not take back a status a timed scan set", () => {
    expect(mergeParcel(SCANNED, bare("in_transit"), "carrier").status).toBe("out_for_delivery");
  });

  it("still reports a delivery", () => {
    expect(mergeParcel(SCANNED, bare("delivered"), "carrier")).toMatchObject({
      status: "delivered",
      delivered: true,
    });
  });

  it("sets the status while nothing timed is stored", () => {
    const untimed = { ...SCANNED, statusAt: null };
    expect(mergeParcel(untimed, bare("in_transit"), "carrier").status).toBe("in_transit");
  });
});

describe("a delivery without a time", () => {
  let context: TestContext;
  let post: FakeWorld;

  beforeEach(async () => {
    post = new FakeWorld();
    context = await createTestContext({ plugins: [fakePost(post)] });
  });
  afterEach(async () => {
    await context.close();
  });

  it("is dated when it was first seen, so retention can archive it", async () => {
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0000000009",
        status: "delivered",
        rawStatus: "x",
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
    const seen = context.clock.now().toISOString();
    context.clock.advance(60_000);
    await context.services.runner.run(source.id);
    const row = await context.services.db
      .selectFrom("parcels")
      .select("delivered_at")
      .executeTakeFirstOrThrow();
    expect(row.delivered_at).toBe(seen);
  });
});
