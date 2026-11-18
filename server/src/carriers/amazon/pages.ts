import { cleanText, unescapeHtml } from "./text.js";

/**
 * Pure readers over the signed-in order pages. Wherever a page embeds JSON state, that is
 * preferred over visible text; the text is only read for what the state does not carry.
 */

/** One order line on the orders page. */
export interface OrderTile {
  readonly orderId: string;
  readonly lineItemId: string;
  readonly shipmentId: string;
  readonly packageId: string;
  /** Link of the line, relative to the storefront. */
  readonly path: string;
  readonly title: string;
  readonly statusText: string;
  readonly note: string | null;
  readonly placedText: string | null;
  readonly position: number;
}

/** The shipment a line belongs to; a line not yet shipped is keyed by its line id. */
export function shipmentKey(tile: OrderTile): string {
  const shipment =
    tile.shipmentId === ""
      ? `${tile.orderId}-${tile.lineItemId || String(tile.position)}`
      : tile.shipmentId;
  return tile.packageId === "1" ? shipment : `${shipment}-${tile.packageId}`;
}

export interface TrackEvent {
  readonly dateText: string;
  readonly timeText: string;
  readonly message: string;
  readonly location: string | null;
}

/** What a shipment-tracking page carries. */
export interface TrackPage {
  readonly trackingId: string | null;
  readonly carrierCode: string | null;
  readonly carrierHeader: string | null;
  readonly timeZone: string | null;
  readonly shortStatus: string | null;
  readonly milestone: string | null;
  readonly promiseMessage: string | null;
  /** Milliseconds from the read until the predicted window ends, when the page says. */
  readonly windowEndsInMs: number | null;
  readonly events: readonly TrackEvent[];
  /** Anti-forgery token the courier-map calls need. Kept in memory only. */
  readonly csrfToken: string | null;
  /** The page loads Amazon's courier map. */
  readonly mapShown: boolean;
  /** The map's callout, e.g. "4 stops away", in the account's language. */
  readonly callout: string | null;
}

const TILE_RE = /<a class="item-card__link" href="([^"]*)" aria-label="([^"]*)"/g;
const PLACED_RE =
  /,\s*(?:Order placed|Bestellt am|Bestellung aufgegeben(?: am)?)\s+([^,]+)(?:,\s*(.*))?$/s;
const ORDER_ID_RE = /\d{3}-\d{7}-\d{7}/;
const TRACK_LINK_RE = /href="([^"]*\/(?:ship-track|progress-tracker\/package\/?)\?[^"]*)"/;
const TRACK_PAGE_PATH_RE =
  /\/(?:progress-tracker\/package|gp\/your-account\/ship-track)(?:\/ref=[^/]*)?\/?$/;
const CARRIER_RE =
  /(?:Delivery By|Delivered by|Shipped with|Versendet mit|Versand durch|Zustellung durch|Lieferung durch)\s+([A-Za-z0-9_]+)/i;
/** The block that names the courier and the tracking id on the package page. */
const CARRIER_INFO_RE = /id="carrierRelatedInfo-container"[^>]*>(.*?)<\/div>/s;
const CARRIER_HEADER_RE =
  /(?:pt-delivery-card-wrapper"><div><h3|tracking-event-carrier-header">\s*<h2)[^>]*>\s*([^<]*?)\s*<\/h[23]>/;
const TRACKING_ID_RE = /(?:Tracking[\s-]?ID|Sendungsnummer|Trackingnummer)\s*:\s*([A-Za-z0-9-]+)/i;
const STATE_RE = /<script[^>]*page-state[^>]*>\s*(\{.*?\})\s*<\/script>/s;
const EVENT_PART_RE =
  /<span class="tracking-event-(date|time|message|description|location)\b[^"]*"[^>]*>([^<]*)<\/span>/g;
const PASSWORD_FIELD_RE = /<input[^>]+type="password"/i;
const CAPTCHA_RE = /\/errors\/validateCaptcha|id="captchacharacters"/i;
const CSRF_INPUT_RE = /<input[^>]*name="csrfToken"[^>]*value="([^"]+)"/;
const CSRF_SCRIPT_RE = /csrfToken\s*[=:]\s*["']([^"']{8,})["']/;
const MAP_RE = /map-tracking|package-location/;
/** The page names the courier plainly, not by its code. */
const CARRIER_ALIASES: Readonly<Record<string, string>> = { DHL: "DHL_CONNECT" };

function queryOf(path: string): Map<string, string> {
  const query = new Map<string, string>();
  try {
    for (const [key, value] of new URL(path, "https://www.example.invalid/").searchParams) {
      query.set(key.toLowerCase(), value);
    }
  } catch {
    // A malformed link has no parameters to read; the caller skips the line.
  }
  return query;
}

/** Splits an aria-label "<title>, Order placed <date>, <status>[, <note>]". */
function splitLabel(
  label: string,
  isStatus: (text: string) => boolean,
): { title: string; statusText: string; note: string | null; placedText: string | null } {
  const placed = PLACED_RE.exec(label);
  if (placed !== null) {
    const tail = placed[2] ?? "";
    const [statusText = "", ...note] = tail.split(", ");
    return {
      title: label.slice(0, placed.index),
      statusText,
      note: note.length === 0 ? null : note.join(", "),
      placedText: placed[1] ?? null,
    };
  }
  // No "order placed" part: the status is the first segment after the title that reads as one.
  const segments = label.split(", ");
  for (let index = 1; index < segments.length; index += 1) {
    if (isStatus(segments[index] ?? "")) {
      const rest = segments.slice(index + 1);
      return {
        title: segments.slice(0, index).join(", "),
        statusText: segments[index] ?? "",
        note: rest.length === 0 ? null : rest.join(", "),
        placedText: null,
      };
    }
  }
  return { title: label, statusText: "", note: null, placedText: null };
}

/** Every order line on an orders page, in page order. */
export function parseOrderTiles(page: string, isStatus: (text: string) => boolean): OrderTile[] {
  const tiles: OrderTile[] = [];
  let position = 0;
  for (const match of page.matchAll(TILE_RE)) {
    const path = unescapeHtml(match[1] ?? "");
    const label = cleanText(match[2] ?? "");
    const query = queryOf(path);
    const orderId = query.get("orderid") ?? ORDER_ID_RE.exec(path)?.[0] ?? "";
    if (orderId === "") {
      continue;
    }
    const parts = splitLabel(label, isStatus);
    tiles.push({
      orderId,
      lineItemId: query.get("lineitemid") ?? "",
      shipmentId: query.get("shipmentid") ?? "",
      packageId: query.get("packageid") ?? "1",
      path,
      title: parts.title.trim(),
      statusText: parts.statusText.trim(),
      note: parts.note,
      placedText: parts.placedText,
      position,
    });
    position += 1;
  }
  return tiles;
}

export function looksSignedOut(page: string, finalUrl: string): boolean {
  return finalUrl.includes("/ap/signin") || PASSWORD_FIELD_RE.test(page);
}

export function looksLikeCaptcha(page: string, finalUrl: string): boolean {
  return finalUrl.includes("/errors/validateCaptcha") || CAPTCHA_RE.test(page);
}

/** Whether an order-line link already points at the tracking page itself. */
export function isTrackPagePath(path: string): boolean {
  try {
    return TRACK_PAGE_PATH_RE.test(new URL(path, "https://www.example.invalid/").pathname);
  } catch {
    return false;
  }
}

/** The tracking-page link on an order-line page, if it has one. */
export function parseTrackLink(page: string): string | null {
  const match = TRACK_LINK_RE.exec(page);
  return match?.[1] === undefined ? null : unescapeHtml(match[1]);
}

function pageState(page: string): Record<string, unknown> {
  const match = STATE_RE.exec(page);
  if (match?.[1] === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

function nested(state: Record<string, unknown>, key: string, inner: string): unknown {
  const value = state[key];
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[inner]
    : undefined;
}

interface PendingEvent {
  dateText: string;
  timeText: string;
  message: string | null;
  location: string | null;
}

/**
 * Reads the timeline: date headers, then time, message (or description) and an optional
 * location per event. An event ends where the next time or date starts.
 */
function parseEvents(page: string): TrackEvent[] {
  const events: TrackEvent[] = [];
  let dateText = "";
  let pending: PendingEvent | null = null;
  const flush = (): void => {
    const done: PendingEvent | null = pending;
    if (done !== null && done.message !== null && done.message !== "" && done.dateText !== "") {
      events.push({ ...done, message: done.message });
    }
    pending = null;
  };
  for (const match of page.matchAll(EVENT_PART_RE)) {
    const kind = match[1];
    const text = cleanText(match[2] ?? "");
    if (kind === "date" || kind === "time") {
      flush();
      if (kind === "date") {
        dateText = text;
      } else {
        pending = { dateText, timeText: text, message: null, location: null };
      }
    } else if (pending !== null && (kind === "message" || kind === "description")) {
      pending.message ??= text;
    } else if (pending !== null && kind === "location") {
      pending.location = text === "" ? null : text;
    }
  }
  flush();
  return events;
}

/** Reads a shipment-tracking page into carrier, tracking id, state and timeline. */
export function parseTrackPage(page: string): TrackPage {
  const state = pageState(page);
  const header = CARRIER_HEADER_RE.exec(page)?.[1];
  const carrierHeader = header === undefined || header === "" ? null : cleanText(header);
  const info = CARRIER_INFO_RE.exec(page)?.[1];
  const infoText = info === undefined ? null : cleanText(info.replace(/<[^>]*>/g, " "));
  const carrier =
    (infoText === null ? undefined : CARRIER_RE.exec(infoText)?.[1]) ??
    CARRIER_RE.exec(carrierHeader ?? page)?.[1];
  const trackingId =
    str(state["trackingId"]) ??
    (infoText === null ? undefined : TRACKING_ID_RE.exec(infoText)?.[1]) ??
    TRACKING_ID_RE.exec(page)?.[1] ??
    null;
  const mapTracking = state["mapTracking"];
  const countdown = state["timeUntilPredictedDeliveryWindowEnd"];
  const csrf =
    str(state["csrfToken"]) ??
    CSRF_INPUT_RE.exec(page)?.[1] ??
    CSRF_SCRIPT_RE.exec(page)?.[1] ??
    null;
  return {
    trackingId,
    carrierCode: carrier === undefined ? null : (CARRIER_ALIASES[carrier] ?? carrier),
    carrierHeader,
    timeZone: str(state["timezone"]),
    shortStatus: str(state["shortStatus"]),
    milestone: str(nested(state, "progressTracker", "lastReachedMilestone")),
    promiseMessage: str(nested(state, "promise", "promiseMessage")),
    windowEndsInMs: typeof countdown === "number" && Number.isFinite(countdown) ? countdown : null,
    events: parseEvents(page),
    csrfToken: csrf === null ? null : unescapeHtml(csrf),
    mapShown: (mapTracking !== null && typeof mapTracking === "object") || MAP_RE.test(page),
    // Only the callout is read from the map block; its destination coordinates never are.
    callout: str(nested(state, "mapTracking", "calloutMessage")),
  };
}
