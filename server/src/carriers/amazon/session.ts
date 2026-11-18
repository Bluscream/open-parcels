import { z } from "zod";
import { type CookieJar, restoreJar, serializeJar } from "../../plugin/api.js";
import type { TrackPage } from "./pages.js";

/**
 * What the plug-in keeps between runs, in the source's encrypted session store: the storefront
 * cookies, and per shipment what its tracking page said, so delivered shipments are never loaded
 * again and a capped run can rotate through the rest.
 */

const trackSchema = z.object({
  trackingId: z.string().nullable(),
  carrierCode: z.string().nullable(),
  carrierHeader: z.string().nullable(),
  timeZone: z.string().nullable(),
  shortStatus: z.string().nullable(),
  milestone: z.string().nullable(),
  promiseMessage: z.string().nullable(),
  windowEndsInMs: z.number().nullable(),
  events: z.array(
    z.object({
      dateText: z.string(),
      timeText: z.string(),
      message: z.string(),
      location: z.string().nullable(),
    }),
  ),
});

const shipmentSchema = z.object({
  readAt: z.string(),
  final: z.boolean(),
  trackPath: z.string().nullable(),
  track: trackSchema.nullable(),
});
export type RememberedShipment = z.infer<typeof shipmentSchema>;

const sessionSchema = z.object({
  version: z.literal(1),
  jar: z.unknown(),
  shipments: z.record(z.string(), shipmentSchema),
});

export interface AmazonSession {
  readonly jar: CookieJar;
  shipments: Record<string, RememberedShipment>;
}

/** A session the plug-in did not write (or an older shape) starts over empty. */
export function loadSession(saved: unknown): AmazonSession {
  const parsed = sessionSchema.safeParse(saved);
  if (!parsed.success) {
    return { jar: restoreJar(null), shipments: {} };
  }
  return { jar: restoreJar(parsed.data.jar), shipments: parsed.data.shipments };
}

export function serializeSession(session: AmazonSession): unknown {
  return { version: 1, jar: serializeJar(session.jar), shipments: session.shipments };
}

/** The tracking page as remembered: the anti-forgery token is short-lived and never stored. */
export function rememberTrack(track: TrackPage | null): RememberedShipment["track"] {
  if (track === null) {
    return null;
  }
  return {
    trackingId: track.trackingId,
    carrierCode: track.carrierCode,
    carrierHeader: track.carrierHeader,
    timeZone: track.timeZone,
    shortStatus: track.shortStatus,
    milestone: track.milestone,
    promiseMessage: track.promiseMessage,
    windowEndsInMs: track.windowEndsInMs,
    events: track.events.map((event) => ({ ...event })),
  };
}

/**
 * A remembered page, for a shipment not loaded this run. Its promise ("today 14:00 - 16:00") and
 * countdown were relative to the earlier read, so they are dropped; the order line's own arrival
 * text, read fresh, stands in.
 */
export function recallTrack(stored: RememberedShipment["track"]): TrackPage | null {
  return stored === null
    ? null
    : {
        ...stored,
        promiseMessage: null,
        windowEndsInMs: null,
        csrfToken: null,
        mapShown: false,
        callout: null,
      };
}
