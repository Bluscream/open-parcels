import { z } from "zod";
import type { OutboxEvent } from "../../events/types.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";

/** Comment lines keep proxies (and Home Assistant ingress) from closing an idle stream. */
const HEARTBEAT_MS = 25_000;

function formatEvent(event: OutboxEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

function parseLastEventId(
  header: string | undefined,
  query: number | undefined,
): number | undefined {
  if (query !== undefined) {
    return query;
  }
  if (header === undefined || !/^\d+$/.test(header)) {
    return undefined;
  }
  return Number(header);
}

export function registerEventRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/events",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["events"],
        summary: "Server-Sent Events stream of parcel and source events.",
        description:
          "Each message carries `id` (the outbox sequence), `event` (the event type) and JSON `data`. " +
          "Reconnect with `Last-Event-ID` (or `?last_event_id=`) to replay up to 7 days of missed events.",
        querystring: z.object({ last_event_id: z.coerce.number().int().nonnegative().optional() }),
      },
    },
    async (request, reply) => {
      const headerValue = request.headers["last-event-id"];
      const since = parseLastEventId(
        typeof headerValue === "string" ? headerValue : undefined,
        request.query.last_event_id,
      );

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Disables response buffering in nginx-style reverse proxies.
        "x-accel-buffering": "no",
      });
      raw.write("retry: 5000\n\n");

      // Subscribe before replaying so nothing committed in between is lost; the seq guard drops duplicates.
      let lastSent = since ?? Number.MAX_SAFE_INTEGER;
      const pending: OutboxEvent[] = [];
      let replaying = since !== undefined;
      const send = (event: OutboxEvent): void => {
        if (replaying) {
          pending.push(event);
          return;
        }
        if (since !== undefined && event.seq <= lastSent) {
          return;
        }
        lastSent = event.seq;
        raw.write(formatEvent(event));
      };
      const unsubscribe = services.bus.subscribe(send);
      const heartbeat = setInterval(() => raw.write(": keep-alive\n\n"), HEARTBEAT_MS);
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      if (since !== undefined) {
        for (const event of await services.bus.replaySince(since)) {
          lastSent = event.seq;
          raw.write(formatEvent(event));
        }
        replaying = false;
        for (const event of pending.splice(0)) {
          send(event);
        }
      }
    },
  );
}
