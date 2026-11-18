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
import { ctt } from "../carriers/ctt/index.js";
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
import { pocztaPolska } from "../carriers/poczta-polska/index.js";
import { postaSlovenije } from "../carriers/posta-slovenije/index.js";
import { posteItaliane } from "../carriers/poste-italiane/index.js";
import { posti } from "../carriers/posti/index.js";
import { postnl } from "../carriers/postnl/index.js";
import { postnord } from "../carriers/postnord/index.js";
import { quickpac } from "../carriers/quickpac/index.js";
import { sameday } from "../carriers/sameday/index.js";
import { seur } from "../carriers/seur/index.js";
import { shopeeXpress } from "../carriers/shopee-xpress/index.js";
import { slovakParcelService } from "../carriers/slovak-parcel-service/index.js";
import { slovenskaPosta } from "../carriers/slovenska-posta/index.js";
import { speeDee } from "../carriers/speedee/index.js";
import { speedx } from "../carriers/speedx/index.js";
import { straightship } from "../carriers/straightship/index.js";
import { sunyou } from "../carriers/sunyou/index.js";
import { swissPost } from "../carriers/swiss-post/index.js";
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
  register(budbee),
  register(cainiao),
  register(canadapost),
  register(canpar),
  register(cdl),
  register(ceskaposta),
  register(colisprive),
  register(colisweb),
  register(correos),
  register(ctt),
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
  register(pocztaPolska),
  register(postaSlovenije),
  register(posteItaliane),
  register(posti),
  register(postnl),
  register(postnord),
  register(quickpac),
  register(sameday),
  register(seur),
  register(shopeeXpress),
  register(slovakParcelService),
  register(slovenskaPosta),
  register(speeDee),
  register(speedx),
  register(straightship),
  register(sunyou),
  register(swissPost),
  register(tipsa),
  register(trunkrs),
  register(ukrposhta),
  register(uniuni),
  register(usps),
  register(vintedGo),
];
