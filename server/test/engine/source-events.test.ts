import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeWorld, fakePost } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Regressions found by a live end-to-end run: clients learn of new, renamed and idle sources.
 * Every code and label is made up. */

let context: TestContext;
let post: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  context = await createTestContext({ plugins: [fakePost(post)] });
});
afterEach(async () => {
  await context.close();
});

async function outbox(type: string): Promise<Record<string, unknown>[]> {
  const rows = await context.services.db
    .selectFrom("outbox")
    .select("payload")
    .where("type", "=", type)
    .orderBy("seq")
    .execute();
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

const addTracking = (label: string) =>
  context.services.sources.create({
    plugin: "fakepost",
    kind: "tracking",
    label,
    config: {},
    secret: null,
  });

describe("source.added", () => {
  it("fires when the user adds a source, before any run", async () => {
    const source = await addTracking("Made-up tracking");
    expect(await outbox("source.added")).toEqual([
      {
        source: { id: source.id, plugin: "fakepost", label: "Made-up tracking", kind: "tracking" },
        state: "ok",
        detail: "Not run yet.",
      },
    ]);
  });

  it("fires when the app makes a tracking source for a code added by hand", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      barcode: "FP8001",
      direction: "incoming",
      label: null,
    });
    const [added] = await outbox("source.added");
    expect(added?.["source"]).toMatchObject({
      id: parcel.sources[0]?.source_id,
      kind: "tracking",
    });
  });
});

describe("source.updated", () => {
  it("fires with the new label on a rename, and not for an unchanged save", async () => {
    const source = await addTracking("Old made-up name");
    await context.services.sources.updateSettings(source.id, { label: "Old made-up name" });
    expect(await outbox("source.updated")).toEqual([]);
    await context.services.sources.updateSettings(source.id, { label: "New made-up name" });
    const updated = await outbox("source.updated");
    expect(updated).toHaveLength(1);
    expect(updated[0]?.["source"]).toMatchObject({ id: source.id, label: "New made-up name" });
  });
});

describe("a run the plug-in skips on purpose", () => {
  it("claims no success and says why", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "fakepost",
      barcode: "FP8002",
      direction: "incoming",
      label: null,
    });
    const sourceId = parcel.sources[0]?.source_id ?? "";
    const before = await context.services.parcels.repository.get(parcel.id);
    post.idle = "Public tracking off: nothing to look up.";
    await context.services.sources.requestRun(sourceId);
    await context.services.scheduler.runDue();

    const source = await context.services.sources.get(sourceId);
    expect(source).toMatchObject({
      state: "idle",
      stateDetail: "Public tracking off: nothing to look up.",
      lastOkAt: null,
    });
    expect(source?.lastRunAt).not.toBeNull();
    // Nothing was asked, so the parcel is not judged unknown to the carrier.
    expect(await context.services.parcels.repository.get(parcel.id)).toEqual(before);
    const [finished] = await outbox("source.run_finished");
    expect(finished).toMatchObject({
      ok: true,
      state: "idle",
      detail: "Public tracking off: nothing to look up.",
    });

    // An idle source stays scheduled; once it does something again it is OK, the detail clears
    // and the success counts.
    post.idle = undefined;
    await context.services.sources.requestRun(sourceId);
    expect(await context.services.scheduler.runDue()).toBe(1);
    expect(await context.services.sources.get(sourceId)).toMatchObject({
      state: "ok",
      stateDetail: null,
    });
    expect((await context.services.sources.get(sourceId))?.lastOkAt).not.toBeNull();
  });
});
