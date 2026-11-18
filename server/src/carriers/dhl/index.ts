import { z } from "zod";
import { defineCarrier, pastedRedirect, SignInRejectedError } from "../../plugin/api.js";
import { fetchDeAccount } from "./de/account.js";
import { finishSignIn, startSignIn } from "./de/session.js";
import { IBERIA_HOST } from "./iberia.js";
import { fetchNlAccount, NL_HOST, nlSignIn } from "./nl/account.js";
import { fetchPlAccount, plSignIn } from "./pl/account.js";
import { PL_HOST } from "./pl/public.js";
import { SWEDEN_HOST } from "./sweden.js";
import { trackCodes } from "./tracking.js";

/**
 * Sign-in data. A German account source stores the refresh token from the pasted-link sign-in, a
 * Dutch one the account's email and password, a Polish one its device id and session cookies;
 * a tracking source may store the user's own key for
 * DHL's official tracking API.
 */
const secretSchema = z
  .object({
    refreshToken: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    nl: z.object({ email: z.string().min(1), password: z.string().min(1) }).optional(),
    pl: z.object({ deviceId: z.string().min(1), jar: z.unknown() }).optional(),
  })
  .nullable();
type Secret = z.infer<typeof secretSchema>;

const configSchema = z.looseObject({
  /**
   * Regional DHL networks to ask as well, for parcels the gateway does not know: `ES`/`PT`
   * (DHL eCommerce Iberia), `SE` (DHL Freight Sweden) and `PL` (Mój DHL's public lookup, behind a
   * proof-of-work challenge). Off by default, so codes are not
   * sent to back ends that cannot know them.
   */
  regions: z.array(z.enum(["ES", "PT", "SE", "PL"])).optional(),
  /** Which DHL account an account source reads: dhl.de (default), my.dhlecommerce.nl or mojdhl.pl. */
  account: z.enum(["de", "nl", "pl"]).optional(),
});
type Config = z.infer<typeof configSchema>;

/**
 * DHL. Tracking asks the keyless DHL Parcel gateway and, with a key, DHL's official API, and
 * merges their answers. The German account lists everything a dhl.de account sees; the Dutch
 * account everything my.dhlecommerce.nl lists.
 */
export const dhl = defineCarrier<Config, Secret>({
  id: "dhl",
  name: "DHL",
  countries: ["*"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: [
    pastedRedirect<Config, Secret>({
      id: "de_account",
      label: "DHL Germany account (sign in in your browser)",
      kinds: ["account"],
      when: (config) => config.account !== "nl" && config.account !== "pl",
      start: () => Promise.resolve(startSignIn()),
      finish: (context, state, pasted) => finishSignIn(context.http, state, pasted),
    }),
    nlSignIn<Config>({ when: (config) => config.account === "nl" }),
    plSignIn<Config>({ when: (config) => config.account === "pl" }),
    {
      type: "api_key",
      id: "tracking_api_key",
      label: "DHL API key (optional)",
      kinds: ["tracking"],
    },
  ],
  http: {
    // Conservative: these are free services; nothing here needs to be fast.
    limits: {
      "api-gw.dhlparcel.nl": { intervalMs: 6_000, burst: 2 },
      // The official API's free tier allows about one call per five seconds.
      "api-eu.dhl.com": { intervalMs: 6_000, burst: 1 },
      "login.dhl.de": { intervalMs: 5_000, burst: 2 },
      "www.dhl.de": { intervalMs: 6_000, burst: 2 },
      [NL_HOST]: { intervalMs: 6_000, burst: 2 },
      [IBERIA_HOST]: { intervalMs: 6_000, burst: 2 },
      [SWEDEN_HOST]: { intervalMs: 6_000, burst: 2 },
      [PL_HOST]: { intervalMs: 8_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  async fetchAccount(context) {
    if (context.config.account === "nl") {
      const credentials = context.secret?.nl;
      if (credentials === undefined) {
        throw new SignInRejectedError("Sign in to your DHL Netherlands account first.");
      }
      return fetchNlAccount(context, credentials);
    }
    if (context.config.account === "pl") {
      const signedIn = context.secret?.pl;
      if (signedIn === undefined) {
        throw new SignInRejectedError("Sign in to your Mój DHL account first.");
      }
      return fetchPlAccount(context, signedIn);
    }
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
      poland: regions.has("PL"),
    });
  },
});
