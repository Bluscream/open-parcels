import { amazonCarrier } from "../carriers/amazon/index.js";
import { delhivery } from "../carriers/delhivery/index.js";
import { dhl } from "../carriers/dhl/index.js";
import { dpd } from "../carriers/dpd/index.js";
import { dragonfly } from "../carriers/dragonfly/index.js";
import { dynalogic } from "../carriers/dynalogic/index.js";
import { earlyBird } from "../carriers/early-bird/index.js";
import { econt } from "../carriers/econt/index.js";
import { ecoscooting } from "../carriers/ecoscooting/index.js";
import { eltaCourier } from "../carriers/elta-courier/index.js";
import { evri } from "../carriers/evri/index.js";
import { fanCourier } from "../carriers/fan-courier/index.js";
import { hermes } from "../carriers/hermes/index.js";
import { register, type RegisteredPlugin } from "./registry.js";

/**
 * Every carrier plug-in shipped with the server. Each carrier lives in its own folder under
 * `src/carriers/` and imports only the plug-in API; it is registered here with `register()`.
 */
export const BUILTIN_CARRIERS: readonly RegisteredPlugin[] = [
  register(amazonCarrier()),
  register(delhivery),
  register(dhl),
  register(dpd),
  register(dragonfly),
  register(dynalogic),
  register(earlyBird),
  register(econt),
  register(ecoscooting),
  register(eltaCourier),
  register(evri),
  register(fanCourier),
  register(hermes),
];
