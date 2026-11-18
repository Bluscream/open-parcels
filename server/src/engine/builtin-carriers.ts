import { amazonCarrier } from "../carriers/amazon/index.js";
import { dhl } from "../carriers/dhl/index.js";
import { dpd } from "../carriers/dpd/index.js";
import { hermes } from "../carriers/hermes/index.js";
import { pocztaPolska } from "../carriers/poczta-polska/index.js";
import { postaSlovenije } from "../carriers/posta-slovenije/index.js";
import { posteItaliane } from "../carriers/poste-italiane/index.js";
import { posti } from "../carriers/posti/index.js";
import { postnl } from "../carriers/postnl/index.js";
import { quickpac } from "../carriers/quickpac/index.js";
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
  register(pocztaPolska),
  register(postaSlovenije),
  register(posteItaliane),
  register(posti),
  register(postnl),
  register(quickpac),
];
