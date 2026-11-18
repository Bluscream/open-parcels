import { loadRules, mapStatus } from "open-parcels-rules";
import type { ParcelSnapshot } from "../../plugin/api.js";

type ParcelStatus = NonNullable<ParcelSnapshot["status"]>;

/*
 * PostNL track & trace observation codes. The shared rules have no PostNL status table yet;
 * these belong there and are only kept here until they move. `rulesStatus` is asked first so a
 * table published later takes over without a code change.
 */
const OBSERVATIONS: Readonly<Record<string, ParcelStatus>> = {
  A01: "registered",
  A03: "registered",
  M02: "registered",
  ...Object.fromEntries(
    [
      "B01",
      "C02",
      "F01",
      "J01",
      "R01",
      "J10",
      "J04",
      "J21",
      "J31",
      "J32",
      "J30",
      "J39",
      "J40",
      "J46",
      "J44",
      "J55",
      "X01",
      "X02",
      "X03",
      "X04",
      "X08",
      "X19",
      "A21",
      "I07",
      "G01",
      "G03",
      "G05",
      "K01",
      "J14",
      "K70",
      "T04",
      "T02",
      "V06",
    ].map((code) => [code, "in_transit" as const]),
  ),
  H04: "returning",
  J05: "out_for_delivery",
  I08: "at_pickup_point",
  J02: "at_pickup_point",
  J12: "at_pickup_point",
  J23: "at_pickup_point",
  ...Object.fromEntries(
    ["A80", "I01", "I02", "I05", "I10", "I11", "I12", "Z01"].map((code) => [
      code,
      "delivered" as const,
    ]),
  ),
};

/** Notices and admin events: they never move the parcel and inherit the stage before them. */
export const META_CODES = new Set([
  "A04",
  "A18",
  "A19",
  "A24",
  "A25",
  "A44",
  "A65",
  "A94",
  "A95",
  "A96",
  "A98",
  "A20",
  "B03",
  "J09",
  "K33",
  "K50",
  "P21",
  "P02",
]);

/** Status-phase wording, for parcels without any recognised observation. First match wins. */
const PHASES: readonly (readonly [string, ParcelStatus])[] = [
  ["ligt klaar bij postnl punt", "at_pickup_point"],
  ["afgeleverd op postnl punt", "at_pickup_point"],
  ["klaar bij postnl punt", "at_pickup_point"],
  ["teruggestuurd", "returning"],
  ["retour", "returning"],
  ["wordt vandaag bezorgd", "out_for_delivery"],
  ["onderweg naar het bezorgadres", "out_for_delivery"],
  ["onderweg naar de bezorger", "out_for_delivery"],
  ["aangemeld", "registered"],
  ["verwacht", "registered"],
  ["bezorgmoment is bijgewerkt", "in_transit"],
  ["lukt vandaag niet", "in_transit"],
  ["duurt de bezorging wat langer", "in_transit"],
  ["ontvangen", "in_transit"],
  ["gesorteerd", "in_transit"],
  ["onderweg", "in_transit"],
  ["klaar voor verzending", "in_transit"],
  ["de grens over", "in_transit"],
  ["aangekomen in het land van bestemming", "in_transit"],
  ["bezorgd", "delivered"],
];

export function observationStatus(code: string): ParcelStatus | null {
  return mapStatus(loadRules(), "postnl", { code })?.status ?? OBSERVATIONS[code] ?? null;
}

export function phaseStatus(message: string): ParcelStatus | null {
  const folded = message.toLowerCase().replace(/-/g, " ");
  return PHASES.find(([pattern]) => folded.includes(pattern))?.[1] ?? null;
}
