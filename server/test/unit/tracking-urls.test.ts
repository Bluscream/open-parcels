import { describe, expect, it } from "vitest";
import { rulesTrackingUrl } from "../../src/plugin/api.js";

/**
 * The public tracking pages the plug-ins link to, as they were built in code before the
 * templates moved to the shared rules. A rules change that alters one of these fails here.
 */
const N = "AB12 3/4";
const E = encodeURIComponent(N);
type Row = readonly [string, string | undefined, Record<string, string> | undefined, string];
const PAGES: readonly Row[] = [
  ["4px", undefined, undefined, `https://track.4px.com/#/result/0/${E}`],
  ["airmee", undefined, undefined, `https://tracking.airmee.com/track/${E}`],
  ["amazon_shipping", undefined, undefined, `https://track.amazon.com/tracking/${E}`],
  ["amazon_shipping", "en-GB", undefined, `https://track.amazon.co.uk/tracking/${E}`],
  ["amazon_shipping", "it", undefined, `https://track.amazon.it/tracking/${E}`],
  ["amazon_shipping", "es", undefined, `https://track.amazon.es/tracking/${E}`],
  ["amazon_shipping", "fr", undefined, `https://track.amazon.fr/tracking/${E}`],
  [
    "an_post",
    undefined,
    undefined,
    `https://www.anpost.com/Post-Parcels/Track/Search?trackingNumber=${E}`,
  ],
  ["apple_express", undefined, undefined, `https://track.appleexpress.com/en-US/orderNumber/${E}`],
  ["aramex", "en-AU", undefined, `https://www.aramex.com.au/tools/track?l=${E}`],
  ["aramex", "en-NZ", undefined, `https://www.aramex.co.nz/tools/track?l=${E}`],
  ["better_trucks", undefined, undefined, `https://tracking.bettertrucks.com/track/${E}`],
  ["box_now", "el", undefined, `https://boxnow.gr/homepage-gr?track=${E}`],
  ["box_now", "bg", undefined, `https://boxnow.bg/homepage?track=${E}`],
  ["box_now", "hr", undefined, `https://boxnow.hr/?track=${E}`],
  ["box_now", "el-CY", undefined, `https://boxnow.cy/?track=${E}`],
  [
    "bpost",
    undefined,
    undefined,
    `https://track.bpost.cloud/btr/web/#/search?lang=en&itemCode=${E}`,
  ],
  [
    "brt",
    undefined,
    undefined,
    `https://www.mybrt.it/it/mybrt/my-parcels/incoming?parcelNumber=${E}`,
  ],
  ["budbee", undefined, undefined, `https://track.budbee.com/${E}`],
  ["cainiao", undefined, undefined, `https://global.cainiao.com/detail.htm?mailNoList=${E}`],
  [
    "canadapost",
    "en",
    undefined,
    `https://www.canadapost-postescanada.ca/track-reperage/en#/details/${E}`,
  ],
  [
    "canadapost",
    "fr",
    undefined,
    `https://www.canadapost-postescanada.ca/track-reperage/fr#/details/${E}`,
  ],
  [
    "cargus",
    undefined,
    undefined,
    `https://www.cargus.ro/personal/urmareste-coletul/?tracking_number=${E}`,
  ],
  ["cdl", undefined, undefined, `https://apps.cdldelivers.com/Tracking-Page/track?id=${E}`],
  ["ceska_posta", undefined, undefined, `https://www.balikovna.cz/cs/sledovat-balik/-/balik/${E}`],
  [
    "colis_prive",
    undefined,
    { lang: "fr" },
    `https://colisprive.com/moncolis/pages/detailColis.aspx?numColis=${E}&lang=fr`,
  ],
  ["colisweb", undefined, undefined, `https://www.colisweb.com/suivi-livraison?tracking=${E}`],
  [
    "correos",
    undefined,
    undefined,
    `https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number=${E}`,
  ],
  [
    "ctt",
    undefined,
    undefined,
    `https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects=${E}`,
  ],
  ["ctt", "es", undefined, `https://www.cttexpress.com/localizador-de-envios/?sc=${E}`],
  ["dao", undefined, undefined, `https://dao.as/find-din-pakke/#q=${E}`],
  ["delhivery", undefined, undefined, `https://www.delhivery.com/track-v2/package/${E}`],
  [
    "dhl",
    undefined,
    undefined,
    `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${E}`,
  ],
  [
    "dhl",
    "de",
    undefined,
    `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${E}`,
  ],
  ["dhl", "nl", { postcode: "1234AB" }, `https://my.dhlecommerce.nl/portal/tracktrace/${E}/1234AB`],
  ["dpd", "de", undefined, `https://tracking.dpd.de/status/de_DE/parcel/${E}`],
  [
    "dragonfly",
    "nl",
    undefined,
    `https://dragonflyshipping.nl/nl/volg-je-pakket/?tracking-id=${E}`,
  ],
  [
    "dragonfly",
    "en-AU",
    undefined,
    `https://dragonflyshipping.com.au/track-your-package/?tracking-id=${E}`,
  ],
  ["dragonfly", "en-CA", undefined, `https://intelcom.ca/en/track-your-package/?tracking-id=${E}`],
  ["early_bird", undefined, undefined, `https://earlybird.se/spara-och-hjalp?id=${E}`],
  [
    "econt",
    undefined,
    undefined,
    `https://ee.econt.com/load_direct.php?target=EeActivityTraceParcell&shipment_num=${E}`,
  ],
  ["ecoscooting", undefined, undefined, `https://www.ecoscooting.com/tracking/${E}`],
  ["evri", undefined, undefined, `https://www.evri.com/track/parcel/${E}/details`],
  ["fan_courier", undefined, undefined, `https://www.fancourier.ro/awb-tracking/?tracking=${E}`],
  ["fedex", undefined, undefined, `https://www.fedex.com/fedextrack/?trknbr=${E}`],
  ["geniki_taxydromiki", undefined, undefined, `https://taxydromiki.com/track/${E}`],
  ["gls", undefined, undefined, `https://gls-group.com/EU/en/parcel-tracking?match=${E}`],
  [
    "gls",
    "en-CA",
    undefined,
    `https://gls-group.com/CA/en/send-and-receive/track-a-shipment/?match=${E}`,
  ],
  ["gls", "en-PL", undefined, `https://gls-group.com/PL/en/parcel-tracking/?match=${E}`],
  [
    "gls",
    "nl",
    { postcode: "1234AB" },
    `https://www.gls-info.nl/tracking?trackid=${E}&zipcode=1234AB`,
  ],
  ["gls", "es", { postcode: "28001" }, `https://mygls.gls-spain.es/e/${E}/28001/es`],
  ["gls", "pt", { postcode: "1000001" }, `https://mygls.gls-portugal.pt/e/${E}/1000001/pt`],
  ["gofo", undefined, undefined, `https://www.gofoexpress.com/tracking.html?searchID=${E}`],
  ["helthjem", undefined, undefined, `https://helthjem.no/sporing/?trackingReference=${E}`],
  [
    "hermes",
    "de",
    undefined,
    `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation/#${E}`,
  ],
  ["inpost", "pl", undefined, `https://inpost.pl/en/find-parcel?number=${E}`],
  ["inpost", "it", undefined, `https://inpost.it/trova-il-tuo-pacco?number=${E}`],
  [
    "inpost",
    "pt",
    undefined,
    `https://www.inpost.pt/seguimento-do-envio/?exp=${E}&language=pt&pais=PT`,
  ],
  ["inpost", "en-GB", undefined, `https://inpost.co.uk/tracking/result?parcel_code=${E}`],
  ["inpost", "es", undefined, `https://www.inpost.es/seguimiento-del-envio/?exp=${E}&language=ES`],
  ["la_poste", undefined, undefined, `https://www.laposte.fr/outils/suivre-vos-envois?code=${E}`],
  ["matkahuolto", undefined, undefined, `https://www.matkahuolto.fi/seuranta?parcelNumber=${E}`],
  [
    "mondial_relay",
    undefined,
    { brand: "BE" },
    `https://www.mondialrelay.be/nl-be/shipment-tracking?numeroExpedition=${E}&codeMarque=BE`,
  ],
  ["nova_post", undefined, undefined, `https://novaposhta.ua/tracking/${E}`],
  ["nz_post", undefined, undefined, `https://www.nzpost.co.nz/tools/tracking?trackid=${E}`],
  ["oesterreichische_post", undefined, undefined, `https://www.post.at/s/sendungsdetails?snr=${E}`],
  ["ontrac", "en", undefined, `https://www.ontrac.com/tracking/?number=${E}`],
  ["packeta", undefined, undefined, `https://tracking.packeta.com/en/?id=${E}`],
  ["pdn_express", undefined, undefined, `https://pdn.express/en/track/${E}`],
  [
    "planzer",
    undefined,
    undefined,
    `https://tracking.app.planzer.ch/?deliveryNumber=${E}&system=Pak`,
  ],
  ["poczta_polska", "pl", undefined, `https://emonitoring.poczta-polska.pl/?numer=${E}`],
  ["posta_slovenije", undefined, undefined, `https://moja.posta.si/tracking?trackingNumber=${E}`],
  [
    "poste_italiane",
    undefined,
    undefined,
    `https://www.poste.it/cerca/index.html#/risultati-spedizioni/${E}`,
  ],
  ["posten_bring", undefined, undefined, `https://sporing.posten.no/sporing/${E}`],
  ["posti", undefined, undefined, `https://www.posti.fi/seuranta/${E}`],
  ["postnord", undefined, undefined, `https://tracking.postnord.com/en/tracking?id=${E}`],
  ["ppl_cz", undefined, undefined, `https://www.ppl.cz/vyhledat-zasilku?shipmentId=${E}`],
  ["purolator", undefined, undefined, `https://www.purolator.com/en/shipping/tracker?pin=${E}`],
  ["quickpac", undefined, undefined, `https://quickpac.ch/de/tracking?identcode=${E}`],
  ["sameday", "ro", undefined, `https://sameday.ro/status-colet/?awb=${E}`],
  ["sameday", "hu", undefined, `https://sameday.hu/#awb=${E}`],
  ["sameday", "bg", undefined, `https://sameday.bg/status-na-pratkata/?awb=${E}`],
  ["shopee_xpress", "pt-BR", undefined, `https://spx.com.br/track?${E}`],
  ["shopee_xpress", "id", undefined, `https://spx.co.id/track?${E}`],
  ["shopee_xpress", "ms", undefined, `https://spx.com.my/track?${E}`],
  ["shopee_xpress", "en-PH", undefined, `https://spx.ph/track?${E}`],
  ["shopee_xpress", "th", undefined, `https://spx.co.th/track?${E}`],
  ["shopee_xpress", "vi", undefined, `https://spx.vn/track?${E}`],
  ["slovak_parcel_service", undefined, undefined, `https://mysps.sk/sk/tracking/${E}`],
  [
    "slovenska_posta",
    undefined,
    undefined,
    `https://www.posta.sk/en/tracking-of-items#parcel=${E}`,
  ],
  ["speedee", undefined, undefined, `https://www.speedeedelivery.com/track/?tracking=${E}`],
  ["speedx", undefined, undefined, `https://tracking.speedx.io/${E}`],
  [
    "straightship",
    undefined,
    undefined,
    `https://straightship.com/track-your-shipment/tracking-id/${E}/`,
  ],
  ["sunyou", undefined, undefined, `https://sypost.net/search?orderNo=${E}`],
  ["swiss_post", undefined, undefined, `https://service.post.ch/ekp-web/ui/entry/search/${E}`],
  ["trunkrs", undefined, { postcode: "1234AB" }, `https://parcel.trunkrs.nl/${E}/1234AB`],
  ["ukrposhta", undefined, undefined, `https://track.ukrposhta.ua/en/?barcode=${E}`],
  ["usps", undefined, undefined, `https://tools.usps.com/go/TrackConfirmAction?tLabels=${E}`],
  ["vinted_go", undefined, undefined, `https://vintedgo.com/en/tracking/${E}`],
];

describe("carrier tracking pages from the shared rules", () => {
  for (const [carrier, locale, params, expected] of PAGES) {
    it(`${carrier} ${locale ?? "default"}`, () => {
      expect(rulesTrackingUrl(carrier, N, locale, params)).toBe(expected);
    });
  }

  it("is null when a template's placeholders are not all given and nothing else fits", () => {
    expect(rulesTrackingUrl("trunkrs", N)).toBeNull();
    expect(rulesTrackingUrl("colis_prive", N)).toBeNull();
  });
});
