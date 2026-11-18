import { z } from "zod";
import { defineCarrier } from "../../plugin/api.js";
import { fetchDeAccount } from "./account.js";
import { TRACKING_HOST, trackDe } from "./tracking.js";

const configSchema = z.object({
  /**
   * Look tracked codes up on the public tracking page. DPD's robots.txt asks crawlers to stay
   * away from it, so a user can switch it off per source.
   */
  publicTracking: z.boolean().default(true),
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
      value:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      reason:
        "The myDPD sign-in and account pages are served to browsers; other clients get a page without the parcel list.",
    },
  },
  fetchAccount: fetchDeAccount,
  track: trackDe,
});
