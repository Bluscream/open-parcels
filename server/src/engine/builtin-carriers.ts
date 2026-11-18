import { fourPx } from "../carriers/4px/index.js";
import { acsCourier } from "../carriers/acs-courier/index.js";
import { airmee } from "../carriers/airmee/index.js";
import { amazonCarrier } from "../carriers/amazon/index.js";
import { amazonShipping } from "../carriers/amazon-shipping/index.js";
import { ampere } from "../carriers/ampere/index.js";
import { dhl } from "../carriers/dhl/index.js";
import { dpd } from "../carriers/dpd/index.js";
import { hermes } from "../carriers/hermes/index.js";
import { register, type RegisteredPlugin } from "./registry.js";

/**
 * Every carrier plug-in shipped with the server. Each carrier lives in its own folder under
 * `src/carriers/` and imports only the plug-in API; it is registered here with `register()`.
 */
export const BUILTIN_CARRIERS: readonly RegisteredPlugin[] = [
  register(fourPx),
  register(acsCourier),
  register(airmee),
  register(amazonCarrier()),
  register(amazonShipping),
  register(ampere),
  register(dhl),
  register(dpd),
  register(hermes),
];
