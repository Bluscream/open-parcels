import { amazonCarrier } from "../carriers/amazon/index.js";
import { budbee } from "../carriers/budbee/index.js";
import { cainiao } from "../carriers/cainiao/index.js";
import { canadapost } from "../carriers/canadapost/index.js";
import { canpar } from "../carriers/canpar/index.js";
import { cdl } from "../carriers/cdl/index.js";
import { ceskaposta } from "../carriers/ceskaposta/index.js";
import { colisprive } from "../carriers/colisprive/index.js";
import { colisweb } from "../carriers/colisweb/index.js";
import { correos } from "../carriers/correos/index.js";
import { dhl } from "../carriers/dhl/index.js";
import { dpd } from "../carriers/dpd/index.js";
import { hermes } from "../carriers/hermes/index.js";
import { register, type RegisteredPlugin } from "./registry.js";

/**
 * Every carrier plug-in shipped with the server. Each carrier lives in its own folder under
 * `src/carriers/` and imports only the plug-in API; it is registered here with `register()`.
 */
export const BUILTIN_CARRIERS: readonly RegisteredPlugin[] = [
  register(amazonCarrier()),
  register(budbee),
  register(cainiao),
  register(canadapost),
  register(canpar),
  register(cdl),
  register(ceskaposta),
  register(colisprive),
  register(colisweb),
  register(correos),
  register(dhl),
  register(dpd),
  register(hermes),
];
