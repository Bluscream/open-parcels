import { z } from "zod";
import { defineCarrier } from "../../plugin/api.js";
import {
  BROWSER_HEADERS_REASON,
  BROWSER_USER_AGENT,
  DEFAULT_LOCALE,
  LOCALES,
  OFFICIAL_HOST,
  PUBLIC_HOST,
} from "./keys.js";
import { trackCodes } from "./tracking.js";

/**
 * Optional: the user's own UPS developer app (client id and secret), for UPS's official Tracking
 * API. Without it only the keyless public tracking is used.
 */
const secretSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .nullable();

/**
 * UPS. Tracking asks the keyless public tracking, which allows only a few requests per hour per
 * address and is spent one code per run, and, with a developer key, UPS's official Tracking API
 * for every code; the answers are merged.
 */
export const ups = defineCarrier({
  id: "ups",
  name: "UPS",
  countries: ["*"],
  sourceKinds: ["tracking"],
  configSchema: z.looseObject({
    /** The locale sent to UPS. It only changes display texts; the mapped keys do not depend on it. */
    locale: z.enum(LOCALES).optional(),
  }),
  secretSchema,
  signIn: { type: "api_key" },
  http: {
    limits: {
      // The public tracking's real limit is a count, kept by the plug-in's request budget; this
      // only keeps the session start and the lookup from going out back to back.
      [PUBLIC_HOST]: { intervalMs: 5_000, burst: 1 },
      [OFFICIAL_HOST]: { intervalMs: 2_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
    userAgent: { value: BROWSER_USER_AGENT, reason: BROWSER_HEADERS_REASON },
  },
  async track(context, barcodes) {
    return trackCodes(
      context,
      context.secret ?? null,
      barcodes,
      context.config.locale ?? DEFAULT_LOCALE,
    );
  },
});
