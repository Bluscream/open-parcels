import { z } from "zod";
import { carrierKey, defineCarrier } from "../../plugin/api.js";
import { fetchDeAccount } from "./account.js";
import { TRACKING_HOST, trackDe } from "./tracking.js";

const configSchema = z.object({
  /**
   * Look tracked codes up on the public tracking endpoint. Off by default: since late 2026 DPD's
   * bot protection resets every connection to its lookup endpoint from a non-browser client (a
   * plain TLS client is reset before the request; a browser-fingerprinted client gets the HTML
   * page but its lookup request is still reset). Its robots.txt also asks crawlers to stay away.
   * Switch it on only if the endpoint answers again; the myDPD account works regardless.
   */
  publicTracking: z.boolean().default(false),
});

const secretSchema = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .nullable();

/** Every myDPD host gets the same slow pace: a poll chains many postbacks on one session. */
const ACCOUNT_LIMIT = { intervalMs: 4_000, burst: 2 };

/** DPD Germany: the public tracking page and the myDPD account. */
export const dpd = defineCarrier({
  id: "dpd",
  name: "DPD",
  countries: ["DE"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "credentials" },
  http: {
    limits: {
      [TRACKING_HOST]: { intervalMs: 3_000, burst: 2 },
      "www.dpd.com": ACCOUNT_LIMIT,
      "portal.dpd.de": ACCOUNT_LIMIT,
      "my.dpd.de": ACCOUNT_LIMIT,
      "*": ACCOUNT_LIMIT,
    },
    userAgent: {
      value: carrierKey("dpd", "browser_user_agent"),
      reason:
        "The myDPD sign-in and account pages are served to browsers; other clients get a page without the parcel list.",
    },
  },
  fetchAccount: fetchDeAccount,
  track: trackDe,
});
