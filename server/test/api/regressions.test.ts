import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { renderIcs } from "../../src/calendar/ics.js";
import { isPlausibleOrder } from "../../src/domain/order.js";
import { repairOrderShops } from "../../src/engine/order-repair.js";
import { orderOf } from "../../src/mail/interpret.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/* Regressions found by a live end-to-end run. Every code, label and order number is made up. */

let context: TestContext;
let app: App;
let headers: Record<string, string>;

beforeEach(async () => {
  context = await createTestContext();
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
});
afterEach(async () => {
  await context.close();
});

async function parcel(barcode: string, columns: Record<string, string | number | null>) {
  const created = await context.services.parcels.create({
    carrier: "dhl",
    barcode,
    direction: "incoming",
    label: `Parcel ${barcode}`,
  });
  if (Object.keys(columns).length > 0) {
    await context.services.db
      .updateTable("parcels")
      .set(columns)
      .where("id", "=", created.id)
      .execute();
  }
  return created.id;
}

interface Entry {
  parcel_id: string;
  kind: string;
  all_day: boolean;
  start_date: string | null;
  end_date: string | null;
}

async function calendar(): Promise<Entry[]> {
  const response = await app.inject({
    url: `/api/v1/calendar?from=${encodeURIComponent("2026-11-10T00:00:00Z")}&to=${encodeURIComponent("2026-11-30T00:00:00Z")}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json<Entry[]>();
}

describe("date-only calendar entries", () => {
  it("make a delivery known only by its day an all-day entry on that local day", async () => {
    // Midnight in Berlin on 2026-11-17 is 23:00Z the day before.
    const id = await parcel("00340434000000000201", {
      delivered: 1,
      status: "delivered",
      delivered_at: "2026-11-16T23:00:00.000Z",
    });
    expect((await calendar()).find((entry) => entry.parcel_id === id)).toMatchObject({
      kind: "delivered",
      all_day: true,
      start_date: "2026-11-17",
      end_date: "2026-11-18",
    });
  });

  it("make a timed delivery a short timed entry, and a midnight estimate a whole day", async () => {
    const timed = await parcel("00340434000000000202", {
      delivered: 1,
      status: "delivered",
      delivered_at: "2026-11-17T13:05:00.000Z",
    });
    const day = await parcel("00340434000000000203", {
      planned_from: "2026-11-19T23:00:00.000Z",
      planned_to: null,
    });
    const entries = await calendar();
    expect(entries.find((entry) => entry.parcel_id === timed)).toMatchObject({
      all_day: false,
      start_date: null,
    });
    expect(entries.find((entry) => entry.parcel_id === day)).toMatchObject({
      kind: "expected",
      all_day: true,
      start_date: "2026-11-20",
      end_date: "2026-11-21",
    });
  });

  it("show a parcel delivered by hand as delivered, never as still expected", async () => {
    const id = await parcel("00340434000000000204", {
      planned_from: "2026-11-20T09:00:00.000Z",
      planned_to: "2026-11-20T12:00:00.000Z",
      manual_status: "delivered",
    });
    expect((await calendar()).filter((entry) => entry.parcel_id === id)).toEqual([]);
  });

  it("write all-day ICS events on the computed local days", async () => {
    await parcel("00340434000000000205", {
      delivered: 1,
      status: "delivered",
      delivered_at: "2026-11-16T23:00:00.000Z",
    });
    const entries = await context.services.calendar.entries(
      new Date("2026-11-10T00:00:00Z"),
      new Date("2026-11-30T00:00:00Z"),
    );
    const ics = renderIcs(entries, {
      timeZone: "Europe/Berlin",
      name: "Test",
      publicUrl: undefined,
    });
    expect(ics).toContain("DTSTART;VALUE=DATE:20261117");
    expect(ics).toContain("DTEND;VALUE=DATE:20261118");
  });
});

describe("archiving", () => {
  it("returns archived_at, so the UI can show the badge and offer Unarchive", async () => {
    const id = await parcel("00340434000000000206", {});
    const archived = await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${id}`,
      headers,
      payload: { archived: true },
    });
    expect(archived.json<{ archived_at: string | null }>().archived_at).toBe(
      context.clock.now().toISOString(),
    );
    const restored = await app.inject({
      method: "PATCH",
      url: `/api/v1/parcels/${id}`,
      headers,
      payload: { archived: false },
    });
    expect(restored.json<{ archived_at: string | null }>().archived_at).toBeNull();
  });
});

describe("shop attribution", () => {
  it("knows Amazon's order-number format", () => {
    expect(isPlausibleOrder("amazon", "000-0000000-0000001")).toBe(true);
    expect(isPlausibleOrder("amazon", "D01-0000000-0000001")).toBe(true);
    expect(isPlausibleOrder("amazon", "1234567")).toBe(false);
    expect(isPlausibleOrder("example-shop.de", "1234567")).toBe(true);
  });

  it("files a mail order under its sender when the number is not the rule's shop's", () => {
    expect(orderOf("parcel-amazon", "1234567", "example-shop.de")).toEqual({
      shop: "example-shop.de",
      orderNumber: "1234567",
      placedAt: null,
    });
    expect(orderOf("parcel-amazon", "000-0000000-0000001", "amazon.de")?.shop).toBe("amazon");
  });

  it("moves stored orders that cannot be Amazon's to the shop their parcel is named after", async () => {
    const now = context.clock.now().toISOString();
    const orderId = crypto.randomUUID();
    await context.services.db
      .insertInto("orders")
      .values({
        id: orderId,
        shop: "amazon",
        order_number: "1234567",
        placed_at: null,
        status: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await parcel("00340434000000000207", { order_id: orderId, label: "example-shop.de" });
    expect(await repairOrderShops(context.services.db, context.clock)).toBe(1);
    expect(await repairOrderShops(context.services.db, context.clock)).toBe(0);
    const order = await context.services.db
      .selectFrom("orders")
      .select("shop")
      .where("id", "=", orderId)
      .executeTakeFirstOrThrow();
    expect(order.shop).toBe("example-shop.de");
  });
});
