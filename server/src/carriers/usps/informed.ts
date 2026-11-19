import { createHash } from "node:crypto";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  asObject,
  isObject,
  isoTime,
  objects,
  parseJsonBody,
  rulesTrackingUrl,
  snapshot,
  text,
  wallTimeAt,
  zonedIso,
  type FetchResult,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { INFORMED } from "./keys.js";

export const INFORMED_API_HOST = "apis-id.usps.com";
const PACKAGES_URL = `https://${INFORMED_API_HOST}/informed-delivery/v3/dashboard/packages/search`;
/** The inbox answers at most this many per list; a full list may be cut short. */
const LIST_LIMIT = 100;

export interface InformedSecret {
  readonly informed: { readonly refreshToken: string; readonly addresses: string[] };
}

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "session" | "clock" | "reportUnknown">;
type Status = NonNullable<ParcelSnapshot["status"]>;

/**
 * Prefixes of the inbox's `statusCategory`, deliberately narrower than the Tracking API's list:
 * only categories seen in real inboxes. The `status` beside it carries a location suffix.
 */
const PREFIXES: readonly (readonly [string, Status])[] = [
  ["delivered", "delivered"],
  ["out for delivery", "out_for_delivery"],
  ["preparing for delivery", "in_transit"],
  ["on the way", "in_transit"],
  ["accepted", "in_transit"],
  // Still with the shipper's own partner; USPS has not scanned it yet.
  ["usps awaiting item", "registered"],
];

function mapCategory(value: string | null): Status | null {
  const folded = value?.trim().toLowerCase() ?? "";
  return PREFIXES.find(([prefix]) => folded.startsWith(prefix))?.[1] ?? null;
}

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/** The rotating refresh-token chain. Each renewal is saved before its access token is used. */
class Chain {
  #refresh: string;
  readonly #base: string;

  constructor(
    private readonly deps: Deps,
    signedIn: string,
  ) {
    this.#base = fingerprint(signedIn);
    const saved = asObject(deps.session.load());
    const refresh = text(saved["refresh"]);
    this.#refresh = saved["base"] === this.#base && refresh !== null ? refresh : signedIn;
  }

  /** A fresh access token. Only HTTP 400 (a dead chain) means "sign in again". */
  async access(): Promise<string> {
    const response = await this.deps.http.request(new URL(`${INFORMED.am}/oauth2/access_token`), {
      method: "POST",
      headers: { accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: INFORMED.clientId,
        refresh_token: this.#refresh,
        redirect_uri: INFORMED.redirectUri,
      }),
    });
    if (response.status === 400) {
      throw new SignInRejectedError("USPS's sign-in chain expired. Sign in again.");
    }
    if (response.status !== 200) {
      throw new TransientError(`USPS's token renewal answered HTTP ${response.status}.`);
    }
    const body = asObject(parseJsonBody(response.body));
    const access = text(body["access_token"]);
    const refresh = text(body["refresh_token"]);
    if (access === null || refresh === null) {
      throw new UnexpectedResponseError("USPS renewed the sign-in without tokens.");
    }
    this.#refresh = refresh;
    await this.deps.session.save({ base: this.#base, refresh });
    return access;
  }
}

async function search(
  deps: Deps,
  access: string,
  zip11: string,
): Promise<Json | "expired" | "no-content"> {
  const response = await deps.http.request(new URL(PACKAGES_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${access}`,
      origin: "https://informeddelivery.usps.com",
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      ZIP11: zip11,
      deliveryDate: usDate(deps.clock.now().getTime()),
      source: "CP",
      electronicSignatureEligible: false,
      maxInboundPackages: LIST_LIMIT,
      maxAddedPackages: LIST_LIMIT,
      campaigns: true,
    }),
  });
  if (response.status === 401) {
    const code = text(asObject(parseJsonBody(response.body))["code"]) ?? "";
    if (["", "401", "TOKEN_EXPIRED", "EXPIRED_TOKEN"].includes(code)) {
      return "expired";
    }
    throw new SignInRejectedError("USPS revoked the Informed Delivery session.");
  }
  if (response.status === 204) {
    // No body says nothing about what the inbox holds; read as "nothing known", never as empty.
    return "no-content";
  }
  if (response.status !== 200) {
    throw new TransientError(`USPS's inbox answered HTTP ${response.status}.`);
  }
  const payload = parseJsonBody(response.body);
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("USPS's inbox did not answer with a JSON object.");
  }
  return payload;
}

/** A package list of the inbox. Missing means none; anything but a list is a changed answer. */
function packageList(inbox: Json, key: string): Json[] {
  const value = inbox[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new UnexpectedResponseError(`USPS's inbox sent "${key}" as something other than a list.`);
  }
  return objects(value);
}

/** The request date is US Eastern, whatever the address's own zone. */
function usDate(epochMs: number): string {
  const wall = wallTimeAt(epochMs, "America/New_York");
  return `${wall.year}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}`;
}

const CLOCK = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?/i;

function clock(value: string): { hour: number; minute: number } | null {
  const match = CLOCK.exec(value);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2] ?? 0);
  if (match === null || hour < 1 || hour > 12 || minute > 59) {
    return null;
  }
  return { hour: (hour % 12) + (match[3]?.toLowerCase() === "p" ? 12 : 0), minute };
}

/** The expected window: the whole day, narrowed by "by 9:00pm" or "between 1:00pm and 3:00pm". */
function window(day: string | null, hint: string | null, zone: string) {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? "");
  if (date === null) {
    return { from: null, to: null };
  }
  const [year, month, dayOfMonth] = [Number(date[1]), Number(date[2]), Number(date[3])];
  const at = (time: { hour: number; minute: number }, second = 0) =>
    zonedIso({ year, month, day: dayOfMonth, ...time, second }, zone);
  const value = hint?.trim() ?? "";
  const between = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(value);
  let start: { hour: number; minute: number } | null = null;
  let end: { hour: number; minute: number } | null = null;
  if (between !== null) {
    const [a, b] = [clock(between[1] ?? ""), clock(between[2] ?? "")];
    // A nonsensical range keeps the whole day.
    if (a !== null && b !== null && a.hour * 60 + a.minute < b.hour * 60 + b.minute) {
      [start, end] = [a, b];
    }
  } else if (/^by\s+/i.test(value)) {
    end = clock(value);
  }
  return {
    from: at(start ?? { hour: 0, minute: 0 }),
    to: end === null ? at({ hour: 23, minute: 59 }, 59) : at(end),
  };
}

export function informedSnapshot(
  raw: Json,
  zone: string,
  report: (category: string) => void,
): ParcelSnapshot | null {
  const barcode = text(raw["trackingNumber"]);
  if (barcode === null) {
    return null;
  }
  const info = asObject(raw["deliveryInfo"]);
  const category = text(info["statusCategory"]) ?? text(info["status"]);
  const status = mapCategory(category);
  if (category !== null && status === null) {
    report(category);
  }
  const delivered = status === "delivered";
  const planned = delivered
    ? { from: null, to: null }
    : window(
        text(info["deliveryDate"]) ?? text(raw["expectedDeliveryDate"]),
        text(info["text2"]),
        zone,
      );
  return snapshot({
    carrier: "usps",
    barcode,
    status,
    rawStatus: text(info["status"]) ?? category,
    delivered,
    deliveredAt: delivered ? isoTime(raw["eventTimestamp"], { naive: { zone } }) : null,
    plannedFrom: planned.from,
    plannedTo: planned.to,
    sender: text(raw["shipperName"]),
    url:
      rulesTrackingUrl("usps", barcode) ??
      `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(barcode)}`,
    raw,
  });
}

/** Every package the enrolled addresses expect. `zone` is where the addresses are. */
export async function fetchInformed(
  deps: Deps,
  secret: InformedSecret,
  zone: string,
): Promise<FetchResult> {
  const chain = new Chain(deps, secret.informed.refreshToken);
  let access = await chain.access();
  const snapshots: ParcelSnapshot[] = [];
  let complete = true;
  for (const zip11 of secret.informed.addresses) {
    let inbox = await search(deps, access, zip11);
    if (inbox === "expired") {
      access = await chain.access();
      inbox = await search(deps, access, zip11);
      if (inbox === "expired") {
        throw new SignInRejectedError("USPS refused a freshly renewed session.");
      }
    }
    if (inbox === "no-content") {
      complete = false;
      continue;
    }
    const lists = [packageList(inbox, "inboundPackages"), packageList(inbox, "addedPackages")];
    complete &&= lists.every((records) => records.length < LIST_LIMIT);
    for (const record of lists.flat()) {
      const parcel = informedSnapshot(record, zone, (category) => {
        deps.reportUnknown("informed_status", category);
      });
      if (parcel === null) {
        // A package without a tracking number is left out, so the list is not everything.
        complete = false;
      } else if (!snapshots.some((known) => known.barcode === parcel.barcode)) {
        snapshots.push(parcel);
      }
    }
  }
  return { snapshots, complete };
}
