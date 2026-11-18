import { z } from "zod";
import { defineCarrier, SignInRejectedError } from "../../plugin/api.js";
import { fetchDeAccount } from "./de/account.js";
import { finishSignIn, startSignIn } from "./de/session.js";
import { IBERIA_HOST } from "./iberia.js";
import { SWEDEN_HOST } from "./sweden.js";
import { trackCodes } from "./tracking.js";

/**
 * Sign-in data. An account source stores the refresh token from the pasted-link sign-in; a
 * tracking source may store the user's own key for DHL's official tracking API.
 */
const secretSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .nullable();

/**
 * DHL. Tracking asks the keyless DHL Parcel gateway and, with a key, DHL's official API, and
 * merges their answers. The German account lists everything a dhl.de account sees.
 */
export const dhl = defineCarrier({
  id: "dhl",
  name: "DHL",
  countries: ["*"],
  sourceKinds: ["account", "tracking"],
  configSchema: z.looseObject({
    /**
     * Regional DHL networks to ask as well, for parcels the gateway does not know: `ES`/`PT`
     * (DHL eCommerce Iberia) and `SE` (DHL Freight Sweden). Off by default, so codes are not
     * sent to back ends that cannot know them.
     */
    regions: z.array(z.enum(["ES", "PT", "SE"])).optional(),
  }),
  secretSchema,
  signIn: {
    type: "pasted_redirect",
    start: () => Promise.resolve(startSignIn()),
    finish: (context, state, pasted) => finishSignIn(context.http, state, pasted),
  },
  http: {
    // Conservative: these are free services; nothing here needs to be fast.
    limits: {
      "api-gw.dhlparcel.nl": { intervalMs: 6_000, burst: 2 },
      // The official API's free tier allows about one call per five seconds.
      "api-eu.dhl.com": { intervalMs: 6_000, burst: 1 },
      "login.dhl.de": { intervalMs: 5_000, burst: 2 },
      "www.dhl.de": { intervalMs: 6_000, burst: 2 },
      [IBERIA_HOST]: { intervalMs: 6_000, burst: 2 },
      [SWEDEN_HOST]: { intervalMs: 6_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  async fetchAccount(context) {
    const refreshToken = context.secret?.refreshToken;
    if (refreshToken === undefined) {
      throw new SignInRejectedError("Sign in to your DHL account first.");
    }
    return fetchDeAccount(context, refreshToken);
  },
  async track(context, barcodes) {
    const regions = new Set(context.config.regions ?? []);
    return trackCodes(context, context.secret?.apiKey ?? null, barcodes, {
      iberia: regions.has("ES") || regions.has("PT"),
      sweden: regions.has("SE"),
    });
  },
});
