import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { isWholeDays } from "../../src/calendar/service.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

const TZ = "Europe/Berlin";
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

async function parcelWithWindow(
  barcode: string,
  from: string | null,
  to: string | null,
): Promise<string> {
  const parcel = await context.services.parcels.create({
    carrier: "dhl",
    barcode,
    direction: "incoming",
    label: `Parcel ${barcode}`,
  });
  await context.services.db
    .updateTable("parcels")
    .set({ planned_from: from, planned_to: to })
    .where("id", "=", parcel.id)
    .execute();
  return parcel.id;
}

async function calendar(from: string, to: string) {
  const response = await app.inject({
    url: `/api/v1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json<
    { uid: string; all_day: boolean; kind: string; late: boolean; start: string; end: string }[]
  >();
}

describe("whole-day windows", () => {
  it("recognise local midnight to midnight and midnight to 23:59", () => {
    // 2026-11-20 00:00 Berlin = 2026-11-19T23:00Z.
    expect(
      isWholeDays(new Date("2026-11-19T23:00:00Z"), new Date("2026-11-20T23:00:00Z"), TZ),
    ).toBe(true);
    expect(
      isWholeDays(new Date("2026-11-19T23:00:00Z"), new Date("2026-11-20T22:59:00Z"), TZ),
    ).toBe(true);
    expect(
      isWholeDays(new Date("2026-11-20T14:00:00Z"), new Date("2026-11-20T17:00:00Z"), TZ),
    ).toBe(false);
    // Midnight to 06:00 is a timed window, not a day.
    expect(
      isWholeDays(new Date("2026-11-19T23:00:00Z"), new Date("2026-11-20T05:00:00Z"), TZ),
    ).toBe(false);
  });
});

describe("calendar entries", () => {
  it("show whole-day estimates as all-day and narrow the same entry when a time window arrives", async () => {
    const id = await parcelWithWindow(
      "00340434000000000001",
      "2026-11-19T23:00:00Z",
      "2026-11-21T23:00:00Z",
    );
    const [allDay] = await calendar("2026-11-18T00:00:00Z", "2026-11-30T00:00:00Z");
    expect(allDay).toMatchObject({ uid: `${id}@open-parcels`, all_day: true, kind: "expected" });

    await context.services.db
      .updateTable("parcels")
      .set({ planned_from: "2026-11-20T16:15:00Z", planned_to: "2026-11-20T18:15:00Z" })
      .where("id", "=", id)
      .execute();
    const [narrowed] = await calendar("2026-11-18T00:00:00Z", "2026-11-30T00:00:00Z");
    expect(narrowed).toMatchObject({
      uid: `${id}@open-parcels`,
      all_day: false,
      start: "2026-11-20T16:15:00.000Z",
    });
  });

  it("mark late parcels and keep delivered ones on their delivery day", async () => {
    await parcelWithWindow("00340434000000000002", "2026-11-17T10:00:00Z", "2026-11-17T12:00:00Z");
    const delivered = await context.services.parcels.create({
      carrier: "dhl",
      barcode: "00340434000000000003",
      direction: "incoming",
      label: null,
    });
    await context.services.db
      .updateTable("parcels")
      .set({ delivered: 1, status: "delivered", delivered_at: "2026-11-18T09:30:00Z" })
      .where("id", "=", delivered.id)
      .execute();
    const entries = await calendar("2026-11-16T00:00:00Z", "2026-11-20T00:00:00Z");
    expect(entries.map((entry) => [entry.kind, entry.late])).toEqual([
      ["expected", true],
      ["delivered", false],
    ]);
  });

  it("rejects inverted or huge ranges", async () => {
    const inverted = await app.inject({
      url: "/api/v1/calendar?from=2026-11-20T00:00:00Z&to=2026-11-10T00:00:00Z",
      headers,
    });
    expect(inverted.statusCode).toBe(400);
  });
});

describe("archived parcels", () => {
  it("keep their delivery in the calendar and the feed; archived undelivered ones do not show", async () => {
    const delivered = await context.services.parcels.create({
      carrier: "dhl",
      barcode: "00340434000000000011",
      direction: "incoming",
      label: "Archived delivery",
    });
    const lost = await parcelWithWindow(
      "00340434000000000012",
      "2026-11-17T10:00:00Z",
      "2026-11-17T12:00:00Z",
    );
    await context.services.db
      .updateTable("parcels")
      .set({
        delivered: 1,
        status: "delivered",
        delivered_at: "2026-11-17T09:30:00Z",
        archived_at: "2026-11-18T00:00:00Z",
      })
      .where("id", "=", delivered.id)
      .execute();
    await context.services.db
      .updateTable("parcels")
      .set({ archived_at: "2026-11-18T00:00:00Z" })
      .where("id", "=", lost)
      .execute();

    const entries = await calendar("2026-11-16T00:00:00Z", "2026-11-20T00:00:00Z");
    expect(entries.map((entry) => [entry.uid, entry.kind])).toEqual([
      [`${delivered.id}@open-parcels`, "delivered"],
    ]);
    const { path } = (
      await app.inject({ method: "POST", url: "/api/v1/calendar/feed", headers })
    ).json<{ path: string }>();
    const feed = (await app.inject({ url: path })).body;
    expect(feed).toContain(`UID:${delivered.id}@open-parcels`);
    expect(feed).not.toContain(lost);

    // Deleted is gone everywhere.
    await context.services.parcels.delete(delivered.id);
    expect(await calendar("2026-11-16T00:00:00Z", "2026-11-20T00:00:00Z")).toEqual([]);
  });
});

describe("ICS feed", () => {
  it("serves date-only all-day events and timed events under a secret address", async () => {
    await parcelWithWindow("00340434000000000001", "2026-11-19T23:00:00Z", "2026-11-21T23:00:00Z");
    await parcelWithWindow("00340434000000000002", "2026-11-20T16:15:00Z", "2026-11-20T18:15:00Z");
    const created = await app.inject({ method: "POST", url: "/api/v1/calendar/feed", headers });
    expect(created.statusCode).toBe(201);
    const { path } = created.json<{ path: string }>();

    const feed = await app.inject({ url: path });
    expect(feed.statusCode).toBe(200);
    expect(feed.headers["content-type"]).toContain("text/calendar");
    const body = feed.body.replace(/\r\n /g, "");
    expect(body).toContain("DTSTART;VALUE=DATE:20261120");
    expect(body).toContain("DTEND;VALUE=DATE:20261122");
    expect(body).toMatch(/DTSTART(;TZID=Europe\/Berlin)?:20261120T171500/);
    expect(body).toContain("@open-parcels");
  });

  it("returns 404 for unknown addresses and invalidates the old one on rotation", async () => {
    const first = (
      await app.inject({ method: "POST", url: "/api/v1/calendar/feed", headers })
    ).json<{ path: string }>().path;
    const second = (
      await app.inject({ method: "POST", url: "/api/v1/calendar/feed", headers })
    ).json<{ path: string }>().path;
    expect((await app.inject({ url: first })).statusCode).toBe(404);
    expect((await app.inject({ url: second })).statusCode).toBe(200);
    expect((await app.inject({ url: "/ical/aaaaaaaaaaaaaaaaaaaaaaaa.ics" })).statusCode).toBe(404);
    await app.inject({ method: "DELETE", url: "/api/v1/calendar/feed", headers });
    expect((await app.inject({ url: second })).statusCode).toBe(404);
  });
});
