import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRetention } from "../../src/engine/retention.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

const DAY = 24 * 60 * 60 * 1000;
let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});
afterEach(async () => {
  await context.close();
});

async function delivered(barcode: string, daysAgo: number): Promise<string> {
  const parcel = await context.services.parcels.create({
    carrier: "dhl",
    barcode,
    direction: "incoming",
    label: null,
  });
  const at = new Date(context.clock.now().getTime() - daysAgo * DAY).toISOString();
  await context.services.db
    .updateTable("parcels")
    .set({ delivered: 1, status: "delivered", delivered_at: at })
    .where("id", "=", parcel.id)
    .execute();
  return parcel.id;
}

describe("retention", () => {
  it("archives delivered parcels after the archive period and deletes them a year later", async () => {
    const policy = {
      archiveAfterDays: 30,
      deleteAfterDays: 365,
      rawAfterDays: 30,
      notFoundArchiveDays: 30,
    };
    const old = await delivered("00340434000000000001", 40);
    const recent = await delivered("00340434000000000002", 5);
    const active = await context.services.parcels.create({
      carrier: "dhl",
      barcode: "00340434000000000003",
      direction: "incoming",
      label: null,
    });

    expect(await applyRetention(context.services.db, context.clock, policy)).toMatchObject({
      archived: 1,
      deleted: 0,
    });
    const archived = await context.services.parcels.repository.list(
      { includeArchived: true },
      false,
    );
    expect(archived.find((parcel) => parcel.id === old)).toBeDefined();
    expect(
      (await context.services.parcels.repository.list({}, false)).map((parcel) => parcel.id).sort(),
    ).toEqual([recent, active.id].sort());

    context.clock.advance(366 * DAY);
    const later = await applyRetention(context.services.db, context.clock, policy);
    expect(later.deleted).toBe(1);
    expect(await context.services.parcels.repository.get(old)).toBeUndefined();
  });
});

describe("diagnostics", () => {
  it("is admin-only and contains no configuration or secrets", async () => {
    const app = await context.app();
    // Reading is open here, but diagnostics need the admin.
    expect((await app.inject("/api/v1/diagnostics")).statusCode).toBe(403);
    const session = await signIn(context, app);
    await context.services.sources.create({
      plugin: "imap",
      kind: "mail",
      label: "Inbox",
      config: { host: "imap.example.invalid" },
      secret: { username: "someone@example.invalid", password: ["made", "up"].join("-") },
    });
    const response = await app.inject({
      url: "/api/v1/diagnostics",
      headers: { cookie: session.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("example.invalid");
    expect(response.body).not.toContain("made-up");
    expect(response.json()).toMatchObject({ sources: [{ plugin: "imap", kind: "mail" }] });
  });
});
