import { z } from "zod";
import { randomSecret, safeEqual, sha256Hex } from "../../auth/crypto.js";
import { isoNow } from "../../clock.js";
import { renderIcs } from "../../calendar/ics.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";

const DAY = 24 * 60 * 60 * 1000;
const FEED_SETTING = "calendar_feed_token_hash";
/** The feed shows a month back and two months ahead. */
const FEED_PAST_MS = 30 * DAY;
const FEED_FUTURE_MS = 60 * DAY;

const entrySchema = z.object({
  uid: z.string(),
  parcel_id: z.uuid(),
  title: z.string(),
  carrier: z.string(),
  barcode: z.string(),
  status: z.string(),
  kind: z.enum(["expected", "delivered"]),
  start: z.string(),
  end: z.string(),
  all_day: z.boolean(),
  start_date: z.iso.date().nullable().describe("All-day entries: the first local day."),
  end_date: z.iso
    .date()
    .nullable()
    .describe("All-day entries: the day after the last (exclusive)."),
  late: z.boolean(),
  image_url: z.string().nullable(),
  url: z.string().nullable(),
  pickup_point: z.string().nullable(),
});

async function feedHash(services: Services): Promise<string | undefined> {
  const row = await services.db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", FEED_SETTING)
    .executeTakeFirst();
  return row === undefined ? undefined : (JSON.parse(row.value) as string);
}

export function registerCalendarRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/calendar",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["calendar"],
        summary:
          "Expected deliveries and delivered parcels in a time range (what the Calendar tab and the ICS feed show).",
        querystring: z.object({
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
        }),
        response: { 200: z.array(entrySchema), 400: errorBodySchema },
      },
    },
    async (request) => {
      const from = new Date(request.query.from);
      const to = new Date(request.query.to);
      if (to <= from || to.getTime() - from.getTime() > 400 * DAY) {
        throw new ApiError(
          400,
          "invalid_range",
          "Use a range that ends after it starts and spans at most 400 days.",
        );
      }
      const entries = await services.calendar.entries(from, to);
      return entries.map((entry) => ({
        uid: entry.uid,
        parcel_id: entry.parcelId,
        title: entry.title,
        carrier: entry.carrier,
        barcode: entry.barcode,
        status: entry.status,
        kind: entry.kind,
        start: entry.start,
        end: entry.end,
        all_day: entry.allDay,
        start_date: entry.startDate,
        end_date: entry.endDate,
        late: entry.late,
        image_url: entry.imageUrl,
        url: entry.url,
        pickup_point: entry.pickupPoint,
      }));
    },
  );

  app.post(
    "/api/v1/calendar/feed",
    {
      preHandler: requireScope("admin"),
      schema: {
        tags: ["calendar"],
        summary:
          "Create (or replace) the secret ICS feed address. The previous address stops working.",
        response: { 201: z.object({ path: z.string(), url: z.string().nullable() }) },
      },
    },
    async (_request, reply) => {
      const token = randomSecret(24);
      const value = JSON.stringify(sha256Hex(token));
      await services.db
        .insertInto("settings")
        .values({ key: FEED_SETTING, value, updated_at: isoNow(services.clock) })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value, updated_at: isoNow(services.clock) }),
        )
        .execute();
      const path = `/ical/${token}.ics`;
      const publicUrl = services.config.publicUrl;
      return reply.code(201).send({
        path,
        url: publicUrl === undefined ? null : new URL(path.slice(1), publicUrl).toString(),
      });
    },
  );

  app.delete(
    "/api/v1/calendar/feed",
    {
      preHandler: requireScope("admin"),
      schema: {
        tags: ["calendar"],
        summary: "Turn the ICS feed off.",
        response: { 204: z.null() },
      },
    },
    async (_request, reply) => {
      await services.db.deleteFrom("settings").where("key", "=", FEED_SETTING).execute();
      return reply.code(204).send(null);
    },
  );

  // Calendar apps cannot send headers, so the feed is authorised by the secret in its path.
  app.get(
    "/ical/:token.ics",
    {
      schema: {
        tags: ["calendar"],
        summary:
          "The ICS feed. Its address is a secret: anyone who has it can read the delivery calendar.",
        security: [],
        params: z.object({ token: z.string().min(16).max(128) }),
      },
    },
    async (request, reply) => {
      const stored = await feedHash(services);
      if (stored === undefined || !safeEqual(stored, sha256Hex(request.params.token))) {
        return reply
          .code(404)
          .send({ error: "not_found", message: "This calendar feed does not exist." });
      }
      const now = services.clock.now();
      const entries = await services.calendar.entries(
        new Date(now.getTime() - FEED_PAST_MS),
        new Date(now.getTime() + FEED_FUTURE_MS),
      );
      const body = renderIcs(entries, {
        timeZone: services.config.timeZone,
        name: "Parcel deliveries",
        publicUrl: services.config.publicUrl,
      });
      return reply
        .header("content-type", "text/calendar; charset=utf-8")
        .header("cache-control", "private, max-age=300")
        .send(body);
    },
  );
}
