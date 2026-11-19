import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_CARRIERS } from "../../src/engine/builtin-carriers.js";
import { acceptsEmptyConfig } from "../../src/engine/linking.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Linking parcels to their carrier's tracking source. Every code is made up. */

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext({ plugins: BUILTIN_CARRIERS });
});
afterEach(async () => {
  await context.close();
});

async function insertParcel(carrier: string, barcode: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = context.clock.now().toISOString();
  await context.services.db
    .insertInto("parcels")
    .values({
      id,
      carrier,
      barcode,
      direction: "incoming",
      status: "registered",
      raw_status: null,
      delivered: 0,
      pickup: 0,
      label: null,
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    })
    .execute();
  return id;
}

describe("linking untracked parcels", () => {
  it("links a parcel of every built-in carrier without throwing", async () => {
    const carriers = context.services.registry.list();
    for (const [index, plugin] of carriers.entries()) {
      await insertParcel(plugin.info.id, `TEST${String(index).padStart(6, "0")}`);
    }
    const result = await context.services.sources.linkUntracked();

    for (const plugin of carriers) {
      const source = await context.services.db
        .selectFrom("sources")
        .select("id")
        .where("plugin", "=", plugin.info.id)
        .where("kind", "=", "tracking")
        .executeTakeFirst();
      const creatable = plugin.canTrack && acceptsEmptyConfig(plugin);
      expect(source !== undefined, plugin.info.id).toBe(creatable);
      expect(result.unlinkedCarriers.has(plugin.info.id), plugin.info.id).toBe(!creatable);
    }
    // The carriers whose settings need a postcode or a country are among those left waiting.
    expect(result.unlinkedCarriers.has("gls")).toBe(true);
    expect(result.unlinkedCarriers.has("evri")).toBe(true);
  });

  it("links a waiting parcel once the user adds the carrier's source", async () => {
    const parcelId = await insertParcel("gls", "TESTGLS000001");
    expect((await context.services.sources.linkUntracked()).parcels).toBe(0);
    const source = await context.services.sources.create({
      plugin: "gls",
      kind: "tracking",
      label: "GLS",
      config: { country: "NL", postalCode: "1234 AB" },
      secret: null,
    });
    expect((await context.services.sources.linkUntracked()).parcels).toBe(1);
    const link = await context.services.db
      .selectFrom("parcel_sources")
      .select("source_id")
      .where("parcel_id", "=", parcelId)
      .executeTakeFirst();
    expect(link?.source_id).toBe(source.id);
  });

  it("stores a code added by hand for a carrier that needs settings, unlinked", async () => {
    const parcel = await context.services.parcels.create({
      carrier: "gls",
      barcode: "TESTGLS000002",
      direction: "incoming",
      label: null,
    });
    expect(parcel.sources).toEqual([]);
  });
});
