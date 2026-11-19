import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../helpers.js";

/* All-day entries on daylight-saving days. The test zone is Europe/Berlin; codes are made up. */

let context: TestContext;

beforeEach(async () => {
  context = await createTestContext();
});
afterEach(async () => {
  await context.close();
});

async function insert(barcode: string, values: Record<string, string | number | null>) {
  const now = context.clock.now().toISOString();
  await context.services.db
    .insertInto("parcels")
    .values({
      id: crypto.randomUUID(),
      carrier: "fakepost",
      barcode,
      direction: "incoming",
      status: "in_transit",
      raw_status: null,
      delivered: 0,
      pickup: 0,
      label: null,
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
      ...values,
    })
    .execute();
}

describe("an all-day entry on a 23-hour day", () => {
  it("ends at the next local midnight, so it covers one day", async () => {
    // 2027-03-28 is the spring-forward day in Berlin: local midnight is 23:00 UTC the day before.
    const midnight = "2027-03-27T23:00:00.000Z";
    await insert("DSTDELIVERED1", {
      status: "delivered",
      delivered: 1,
      delivered_at: midnight,
    });
    await insert("DSTEXPECTED01", { planned_from: midnight });
    const entries = await context.services.calendar.entries(
      new Date("2027-03-20T00:00:00Z"),
      new Date("2027-04-05T00:00:00Z"),
    );
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        allDay: true,
        end: "2027-03-28T22:00:00.000Z",
        startDate: "2027-03-28",
        endDate: "2027-03-29",
      });
    }
  });
});
