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
          "Reconnect with `Last-Event-ID` (or `?last_event_id=`) to replay up to 7 days of missed events. " +
          "A connection without one starts with `ready` (its `id` is the current sequence). When the " +
          "given id is newer than any event or older than what is kept, `resync` (also carrying the " +
          "current sequence as `id`) tells the client to reload everything over REST. " +
          "`parcel.live_position` messages carry the courier's position while en route; they have no `id` and are never replayed.",
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

      // Once hijacked, nothing else ends the response: every exit path goes through `close`.
      let closed = false;
      const cleanups: (() => void)[] = [];
      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        for (const cleanup of cleanups.splice(0)) {
          cleanup();
        }
        raw.destroy();
      };
      request.raw.on("close", close);
      raw.on("error", close);
      raw.on("close", close);
      /**
       * Writes a chunk. A client that lets more than MAX_BUFFERED_BYTES pile up is cut off; it
       * reconnects with Last-Event-ID and is replayed from where it was, without a gap.
       */
      const write = (chunk: string): void => {
        if (closed) {
          return;
        }
        raw.write(chunk);
        if (raw.writableLength > MAX_BUFFERED_BYTES) {
          services.logger.warn("An event stream client fell too far behind; closing it.");
          close();
        }
      };
      /** Waits until the socket has room again, so a long replay never floods the buffer. */
      const drained = async (): Promise<void> => {
        if (!closed && raw.writableNeedDrain) {
          await new Promise<void>((resolve) => {
            raw.once("drain", resolve);
            cleanups.push(resolve);
          });
        }
      };

      write("retry: 5000\n\n");

      // Subscribe before replaying so nothing committed in between is lost; the seq guard drops
      // duplicates. Until the replay has caught up, live events wait in `pending`.
      let lastSent = 0;
      const pending: OutboxEvent[] = [];
      let replaying = true;
      const send = (event: OutboxEvent): void => {
        if (replaying) {
          pending.push(event);
          return;
        }
        if (event.seq <= lastSent) {
          return;
        }
        lastSent = event.seq;
        write(formatEvent(event));
      };
      cleanups.push(services.bus.subscribe(send));
      // Courier positions: no `id`, so they are never part of a replay.
      cleanups.push(
        services.bus.subscribeEphemeral((message) => {
          write(`event: ${message.type}\ndata: ${JSON.stringify(message.payload)}\n\n`);
        }),
      );
      const heartbeat = setInterval(() => {
        write(": keep-alive\n\n");
      }, HEARTBEAT_MS);
      cleanups.push(() => {
        clearInterval(heartbeat);
      });

      try {
        lastSent = await catchUp(services, since, write, drained);
      } catch (error) {
        services.logger.error({ err: error }, "Replaying events failed.");
        close();
        return;
      }
      replaying = false;
      for (const event of pending.splice(0)) {
        send(event);
      }
    },
  );
}

/** Bytes a client may leave unread before its stream is closed. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/**
 * Brings a (re)connecting client up to the bus head and returns the seq it now stands at.
 *
 * - No `Last-Event-ID`: a `ready` message carries the current seq as its id, so a client that
 *   loads its state over REST and then reconnects resumes from here.
 * - A `Last-Event-ID` the server cannot serve (newer than any event, or older than retention):
 *   a `resync` message, also carrying the current seq. The client reloads everything over REST.
 * - Otherwise every missed event, page by page, up to the head.
 */
async function catchUp(
  services: Services,
  since: number | undefined,
  write: (chunk: string) => void,
  drained: () => Promise<void>,
): Promise<number> {
  const { bus } = services;
  const head = bus.head;
  if (since === undefined) {
    write(controlMessage("ready", head, { seq: head }));
    return head;
  }
  // When the outbox is empty, everything up to the head has expired.
  const oldest = (await bus.oldestRetained()) ?? head + 1;
  const reason = since > head ? "ahead" : since < oldest - 1 ? "expired" : null;
  if (reason !== null) {
    write(controlMessage("resync", head, { seq: head, reason }));
    return head;
  }
  let cursor = since;
  for (;;) {
    const page = await bus.replayPage(cursor);
    for (const event of page.events) {
      write(formatEvent(event));
    }
    cursor = page.last;
    if (!page.more) {
      return cursor;
    }
    await drained();
  }
}

function controlMessage(type: "ready" | "resync", seq: number, data: unknown): string {
  return `id: ${String(seq)}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
