import {
  ruleStatus,
  asArray,
  asObject,
  isoTime,
  newestFirst,
  snapshot,
  text,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "sameday";
export const COUNTRIES = ["ro", "hu", "bg"] as const;
export type Country = (typeof COUNTRIES)[number];

/** Sameday's offset-less dates are Romanian local time; numbers are epoch milliseconds. */
const TIME = { naive: { zone: "Europe/Bucharest" }, epoch: "ms" } as const;

/**
 * The numeric `statusStateId` of an AWB event. Returns, cancellations and failures map to the
 * nearest canonical value; postponements and redirects are still in transit (shared table).
 */
export function mapCode(code: string | null): ParcelStatus | null {
  return ruleStatus(CARRIER_ID, code);
}

const PUBLIC_PAGES: Readonly<Record<Country, string>> = {
  ro: "https://sameday.ro/status-colet/?awb=",
  hu: "https://sameday.hu/#awb=",
  bg: "https://sameday.bg/status-na-pratkata/?awb=",
};

interface Entry {
  readonly at: string;
  readonly code: string | null;
  readonly raw: Json;
}

function entries(raw: Json): Entry[] {
  const result: Entry[] = [];
  for (const item of asArray(raw["awbHistory"])) {
    const event = asObject(item);
    const at = isoTime(event["statusDate"], TIME);
    if (at !== null) {
      result.push({ at, code: text(event["statusStateId"]), raw: event });
    }
  }
  return newestFirst(result);
}

function location(event: Json): string | null {
  return text(event["transitLocation"]) ?? text(event["county"]) ?? text(event["country"]);
}

/** Turns one AWB history into a snapshot; `report` receives unmapped status ids. */
export function awbSnapshot(
  raw: Json,
  barcode: string,
  country: Country,
  report: (code: string) => void,
): ParcelSnapshot {
  const events = entries(raw);
  const latest = events[0];
  const code = latest?.code ?? null;
  const status = mapCode(code);
  if (code !== null && status === null) {
    report(code);
  }
  const history: SnapshotEvent[] = events.map((event) => ({
    at: event.at,
    status: mapCode(event.code),
    rawStatus: text(event.raw["statusState"]) ?? event.code ?? "?",
    location: location(event.raw),
  }));
  const atPoint = status === "at_pickup_point";
  return snapshot({
    carrier: CARRIER_ID,
    barcode,
    status,
    rawStatus: latest === undefined ? null : (text(latest.raw["statusState"]) ?? code),
    deliveredAt: status === "delivered" ? (latest?.at ?? null) : null,
    pickup: atPoint,
    pickupPoint: atPoint && latest !== undefined ? location(latest.raw) : null,
    url: `${PUBLIC_PAGES[country]}${encodeURIComponent(barcode)}`,
    history,
    raw,
  });
}
