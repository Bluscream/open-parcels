import { loadRules } from "open-parcels-rules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupMailFalsePositives } from "../../src/engine/mail-cleanup.js";
import { createTestContext, type TestContext } from "../helpers.js";

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});
afterEach(async () => {
  await context.close();
});

async function mailParcel(
  mailSource: string,
  carrier: string,
  barcode: string,
  rawStatus: string,
): Promise<string> {
  const parcel = await context.services.parcels.create({
    carrier,
    barcode,
    direction: "incoming",
    label: null,
  });
  const now = context.clock.now().toISOString();
  await context.services.db
    .updateTable("parcels")
    .set({ raw_status: rawStatus })
    .where("id", "=", parcel.id)
    .execute();
  await context.services.db
    .insertInto("parcel_sources")
    .values({
      parcel_id: parcel.id,
      source_id: mailSource,
      external_ref: null,
      role: "mail",
      last_seen_at: now,
    })
    .execute();
  return parcel.id;
}

describe("mail false-positive cleanup", () => {
  it("archives what the current rules would not create, once, with a reason", async () => {
    const source = await context.services.sources.create({
      plugin: "imap",
      kind: "mail",
      label: "Inbox",
      config: { host: "imap.example.invalid" },
      secret: { username: "someone@example.invalid", password: ["made", "up"].join("-") },
    });
    const portal = await mailParcel(
      source.id,
      "dhl",
      "1795000000",
      "Account details for someone at DHL API Developer Portal",
    );
    const placeholder = await mailParcel(source.id, "dpd", "990000000000002", "Versandt");
    const real = await mailParcel(source.id, "dpd", "09446624362703", "Ihr Paket kommt heute");
    await context.services.db
      .insertInto("items")
      .values([
        { parcel_id: real, position: 0, title: "Enter the recipient's postal code to track" },
        { parcel_id: real, position: 1, title: "Beispielartikel" },
      ])
      .execute();

    const rules = loadRules();
    const first = await cleanupMailFalsePositives(context.services.db, context.clock, rules);
    expect(first).toEqual({
      ran: true,
      archived: { placeholder_or_pattern: 1, ignored_mail: 1 },
      boilerplateItemsRemoved: 1,
    });
    const rows = await context.services.db
      .selectFrom("parcels")
      .select(["id", "archived_at", "archive_reason"])
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(portal)?.archive_reason).toBe("mail-cleanup: ignored_mail");
    expect(byId.get(placeholder)?.archive_reason).toBe("mail-cleanup: placeholder_or_pattern");
    expect(byId.get(real)?.archived_at).toBeNull();
    const titles = await context.services.db.selectFrom("items").select("title").execute();
    expect(titles).toEqual([{ title: "Beispielartikel" }]);

    const second = await cleanupMailFalsePositives(context.services.db, context.clock, rules);
    expect(second.ran).toBe(false);
  });
});
