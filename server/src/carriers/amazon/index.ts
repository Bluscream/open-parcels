import {
  loadRules,
  type Rules,
  defineCarrier,
  SignInRejectedError,
  type CarrierPlugin,
} from "../../plugin/api.js";
import { z } from "zod";
import { readAccount, type AmazonConfig } from "./account.js";
import {
  amazonSecretSchema,
  authorizationCode,
  newDeviceSerial,
  newVerifier,
  registerDevice,
  signInStateSchema,
  signInUrl,
  type AmazonSecret,
} from "./auth.js";
import { AMAZON_ID } from "./build.js";
import { readLive } from "./live.js";
import { STOREFRONT_COUNTRIES, STOREFRONT_IDS, STOREFRONTS } from "./storefronts.js";

const configSchema = z.object({
  storefront: z.enum(STOREFRONT_IDS).describe("The Amazon storefront the account orders from."),
});

/**
 * Pages are read as a mobile browser: the order pages are the website, and with a library
 * User-Agent Amazon serves a robot check instead.
 */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/**
 * One request every five seconds per host, no bursts. A full run costs one orders page plus at
 * most two pages per shipment still moving (capped), so it stays well under a person browsing.
 */
const AMAZON_LIMIT = { intervalMs: 5_000, burst: 1 } as const;

/** The Amazon shop plug-in. `rules` is loaded on first use unless a test passes its own. */
export function amazonCarrier(rules?: Rules): CarrierPlugin<AmazonConfig, AmazonSecret | null> {
  let cached = rules;
  const getRules = (): Rules => (cached ??= loadRules());
  return defineCarrier<AmazonConfig, AmazonSecret | null>({
    id: AMAZON_ID,
    name: "Amazon",
    countries: STOREFRONT_COUNTRIES,
    sourceKinds: ["shop"],
    configSchema,
    secretSchema: amazonSecretSchema.nullable(),
    signIn: {
      type: "pasted_redirect",
      start({ config }) {
        const deviceSerial = newDeviceSerial();
        const verifier = newVerifier();
        const storefront = STOREFRONTS[config.storefront];
        return Promise.resolve({
          url: signInUrl(storefront, deviceSerial, verifier),
          state: { deviceSerial, verifier, storefront: storefront.domain },
        });
      },
      async finish({ http }, rawState, pasted) {
        const state = signInStateSchema.parse(rawState);
        const storefront = STOREFRONTS[configSchema.shape.storefront.parse(state.storefront)];
        const code = authorizationCode(pasted);
        if (code === null) {
          throw new SignInRejectedError("The pasted address holds no Amazon authorisation code.");
        }
        return registerDevice(http, storefront, state, code);
      },
    },
    http: {
      limits: { "*": AMAZON_LIMIT },
      userAgent: {
        value: BROWSER_USER_AGENT,
        reason: "Amazon's order pages answer a library User-Agent with a robot check.",
      },
    },
    fetchAccount: (context) => readAccount(context, getRules()),
    readLive: (context, target) => readLive(context, target),
  });
}
