import { z } from "zod";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type LiveReading,
  type LiveTarget,
} from "../../plugin/api.js";
import type { AmazonContext } from "./account.js";
import { loadSession } from "./session.js";
import { storefrontOrigin, STOREFRONTS } from "./storefronts.js";

const MAP_PATH = "/progress-tracker/package/actions/map-tracking-deans-proxy";

/** Courier-map states, by what they mean for the session. Unknown states stop the reading. */
const LIVE_STATES: Readonly<Record<string, LiveReading["state"]>> = {
  PICKED_UP: "en_route",
  RENDERED: "en_route",
  SKIPPED_STOP: "en_route",
  YOU_ARE_NEXT: "next_stop",
  DELIVERED: "delivered",
  DELIVERED_CONFIRMED: "delivered",
  PARTIALLY_DELIVERED: "ended",
  DELIVERY_ATTEMPTED: "ended",
  DELIVERY_FAILED: "ended",
  NOT_DELIVERED: "ended",
  REJECTED: "ended",
  ADDRESS_NOT_FOUND: "ended",
};

export const liveRefSchema = z.object({
  trackingId: z.string().min(1),
  csrfToken: z.string().min(1).nullable(),
  /** The package page's map callout ("4 stops away") from the last full poll. */
  callout: z.string().nullable().default(null),
});

/** The stop count in a callout such as "4 stops away" or "Noch 4 Stopps". */
export function stopsFromCallout(callout: string | null): number | null {
  const match = callout === null ? null : /\b(\d{1,3})\b/.exec(callout);
  return match?.[1] === undefined ? null : Number(match[1]);
}

const coordinate = z.number();
/** The map sends the stop count as a string ("2"); a bare number is accepted too. */
const stopCount = z.union([
  z.number().int().min(0),
  z
    .string()
    .regex(/^\d{1,3}$/)
    .transform(Number),
]);
const mapAnswerSchema = z.object({
  success: z.boolean(),
  packageLocationDetails: z
    .object({
      trackingObjectState: z.string(),
      stopsRemaining: stopCount.nullable().optional(),
      transporterDetails: z
        .object({
          geoLocation: z
            .object({
              latitude: coordinate.min(-90).max(90),
              longitude: coordinate.min(-180).max(180),
              accuracy: z.number().min(0).nullable().optional(),
              /** Epoch seconds. */
              locationTime: z.number().positive().nullable().optional(),
            })
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

function parseAnswer(response: HttpResponse): z.infer<typeof mapAnswerSchema> {
  let body: unknown;
  try {
    body = response.json();
  } catch {
    throw new UnexpectedResponseError("Amazon's courier map answer was not JSON.");
  }
  const parsed = mapAnswerSchema.safeParse(body);
  if (!parsed.success) {
    throw new UnexpectedResponseError("Amazon's courier map answer had an unexpected shape.");
  }
  return parsed.data;
}

/**
 * Reads the courier's position for one shipment of Amazon's own fleet. Uses the cookies of the
 * last full run and never mints new ones: a refused or failed read is a failure the live tracker
 * counts, and the next full poll renews the session. Only the courier's own position is read;
 * the destination in the same answer is ignored.
 */
export async function readLive(
  context: AmazonContext,
  target: LiveTarget,
): Promise<LiveReading | null> {
  const ref = liveRefSchema.safeParse(target.ref);
  if (!ref.success || ref.data.csrfToken === null) {
    return null;
  }
  const storefront = STOREFRONTS[context.config.storefront];
  const session = loadSession(context.session.load());
  const origin = storefrontOrigin(storefront);
  if ((await session.jar.getCookies(origin)).length === 0) {
    return null;
  }
  const response = await context.http.request(new URL(MAP_PATH, origin), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-requested-with": "XMLHttpRequest",
    },
    // The page's own map sends every field wrapped in an array under `formData`.
    body: JSON.stringify({
      formData: { trackingId: [ref.data.trackingId], csrfToken: [ref.data.csrfToken] },
    }),
    jar: session.jar,
    redirect: "manual",
  });
  const location = response.headers.get("location") ?? "";
  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status >= 300 && response.status < 400 && location.includes("/ap/signin"))
  ) {
    // The session is gone. The live tracker counts this as a failure; it never signs in again.
    throw new SignInRejectedError("Amazon's courier map asks for a new sign-in.");
  }
  if (response.status !== 200) {
    throw new TransientError(`Amazon's courier map answered HTTP ${String(response.status)}.`);
  }
  const answer = parseAnswer(response);
  const details = answer.packageLocationDetails ?? null;
  if (!answer.success || details === null) {
    return null;
  }
  const state = LIVE_STATES[details.trackingObjectState];
  if (state === undefined) {
    context.reportUnknown("live_state", details.trackingObjectState);
    throw new UnexpectedResponseError("Amazon's courier map reported a state we do not know.");
  }
  const fix = state === "en_route" ? (details.transporterDetails?.geoLocation ?? null) : null;
  return {
    state,
    stopsAway: details.stopsRemaining ?? stopsFromCallout(ref.data.callout),
    latitude: fix?.latitude ?? null,
    longitude: fix?.longitude ?? null,
    accuracy: fix?.accuracy ?? null,
    positionAt:
      fix?.locationTime === undefined || fix.locationTime === null
        ? null
        : new Date(fix.locationTime * 1000).toISOString(),
    message: ref.data.callout,
  };
}
