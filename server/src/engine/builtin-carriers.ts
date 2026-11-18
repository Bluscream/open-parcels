import { amazonCarrier } from "../carriers/amazon/index.js";
import { dhl } from "../carriers/dhl/index.js";
import { dpd } from "../carriers/dpd/index.js";
import { genikiTaxydromiki } from "../carriers/geniki_taxydromiki/index.js";
import { gls } from "../carriers/gls/index.js";
import { gobolt } from "../carriers/gobolt/index.js";
import { gofo } from "../carriers/gofo/index.js";
import { helthjem } from "../carriers/helthjem/index.js";
import { hermes } from "../carriers/hermes/index.js";
import { hrvatskaPosta } from "../carriers/hrvatska_posta/index.js";
import { icsCourier } from "../carriers/ics_courier/index.js";
import { inpost } from "../carriers/inpost/index.js";
import { laposte } from "../carriers/laposte/index.js";
import { magyarPosta } from "../carriers/magyar_posta/index.js";
import { matkahuolto } from "../carriers/matkahuolto/index.js";
import { mondialRelay } from "../carriers/mondial_relay/index.js";
import { novaPost } from "../carriers/nova_post/index.js";
import { nzPost } from "../carriers/nz_post/index.js";
import { oesterreichischePost } from "../carriers/oesterreichische_post/index.js";
import { ontrac } from "../carriers/ontrac/index.js";
import { orlenPaczka } from "../carriers/orlen_paczka/index.js";
import { paack } from "../carriers/paack/index.js";
import { packeta } from "../carriers/packeta/index.js";
import { pdnExpress } from "../carriers/pdn_express/index.js";
import { planzer } from "../carriers/planzer/index.js";
import { register, type RegisteredPlugin } from "./registry.js";

/**
 * Every carrier plug-in shipped with the server. Each carrier lives in its own folder under
 * `src/carriers/` and imports only the plug-in API; it is registered here with `register()`.
 */
export const BUILTIN_CARRIERS: readonly RegisteredPlugin[] = [
  register(amazonCarrier()),
  register(dhl),
  register(dpd),
  register(genikiTaxydromiki),
  register(gls),
  register(gobolt),
  register(gofo),
  register(helthjem),
  register(hermes),
  register(hrvatskaPosta),
  register(icsCourier),
  register(inpost),
  register(laposte),
  register(magyarPosta),
  register(matkahuolto),
  register(mondialRelay),
  register(novaPost),
  register(nzPost),
  register(oesterreichischePost),
  register(ontrac),
  register(orlenPaczka),
  register(paack),
  register(packeta),
  register(pdnExpress),
  register(planzer),
];
