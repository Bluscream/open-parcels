import { amazonCarrier } from "../carriers/amazon/index.js";
import { dhl } from "../carriers/dhl/index.js";
import { dpd } from "../carriers/dpd/index.js";
import { hermes } from "../carriers/hermes/index.js";
import { tipsa } from "../carriers/tipsa/index.js";
import { trunkrs } from "../carriers/trunkrs/index.js";
import { ukrposhta } from "../carriers/ukrposhta/index.js";
import { uniuni } from "../carriers/uniuni/index.js";
import { usps } from "../carriers/usps/index.js";
import { vintedGo } from "../carriers/vinted_go/index.js";
import { register, type RegisteredPlugin } from "./registry.js";

/**
 * Every carrier plug-in shipped with the server. Each carrier lives in its own folder under
 * `src/carriers/` and imports only the plug-in API; it is registered here with `register()`.
 */
export const BUILTIN_CARRIERS: readonly RegisteredPlugin[] = [
  register(amazonCarrier()),
  register(dhl),
  register(dpd),
  register(hermes),
  register(tipsa),
  register(trunkrs),
  register(ukrposhta),
  register(uniuni),
  register(usps),
  register(vintedGo),
];
