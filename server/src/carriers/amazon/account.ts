import { mapStatus, type Rules } from "open-parcels-rules";
import {
  CaptchaError,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type FetchResult,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { mintCookies, type AmazonSecret } from "./auth.js";
import { AMAZON_ID, buildSnapshot, isSkipped, readsAsStatus } from "./build.js";
import { pastDay, today, type Day } from "./dates.js";
import {
  isTrackPagePath,
  looksLikeCaptcha,
  looksSignedOut,
  parseOrderTiles,
  parseTrackLink,
  parseTrackPage,
  shipmentKey,
  type OrderTile,
  type TrackPage,
} from "./pages.js";
import {
  loadSession,
  recallTrack,
  rememberTrack,
  serializeSession,
  type AmazonSession,
} from "./session.js";
import {
  onStorefront,
  storefrontOrigin,
  STOREFRONTS,
  type Storefront,
  type StorefrontId,
} from "./storefronts.js";

export interface AmazonConfig {
  readonly storefront: StorefrontId;
}
export type AmazonContext = PluginContext<AmazonConfig, AmazonSecret | null>;

/** The orders page, then the older order-history path some accounts are still sent to. */
const ORDERS_PATHS = ["/your-orders/orders", "/gp/css/order-history"] as const;
/** Every shipment costs up to two page loads; a run never loads more than this many shipments. */
export const MAX_SHIPMENT_LOADS = 8;
/** Delivered shipments older than this are listed from the order line alone, never loaded. */
const DELIVERED_LOOKBACK_DAYS = 7;
/** Any Amazon storefront may appear in a redirect (sign-in lives on amazon.com for some). */
const AMAZON_HOST_RE = /^(?:www\.)?amazon\.(?:com|de|co\.uk|ie|ca|com\.au|in)$/;

interface Page {
  readonly body: string;
  readonly url: string;
}

/**
 * Loads signed-in pages of one storefront. Cookies are minted from the refresh token only when
 * the jar is empty or Amazon shows a sign-in page, and at most once per run: a second sign-in
 * page means the stored sign-in is refused. Network errors propagate as they are, so they never
 * lead to a new sign-in.
 */
export class StorefrontReader {
  #minted = false;
  readonly #allow: (target: URL) => boolean;

  constructor(
    private readonly context: AmazonContext,
    private readonly storefront: Storefront,
    private readonly session: AmazonSession,
  ) {
    const own = onStorefront(storefront);
    this.#allow = (target) =>
      own(target) || (target.protocol === "https:" && AMAZON_HOST_RE.test(target.hostname));
  }

  async #mint(): Promise<void> {
    const secret = this.context.secret;
    if (secret === null) {
      throw new SignInRejectedError("Amazon is not signed in yet.");
    }
    this.#minted = true;
    await mintCookies(this.context.http, this.storefront, secret.refreshToken, this.session.jar);
  }

  /** The cookie jar, minted first when it holds nothing for the storefront. */
  async ensureCookies(): Promise<void> {
    const cookies = await this.session.jar.getCookies(storefrontOrigin(this.storefront));
    if (cookies.length === 0) {
      await this.#mint();
    }
  }

  /** One page; null when Amazon answers 404. */
  async page(path: string): Promise<Page | null> {
    const url = new URL(path, storefrontOrigin(this.storefront));
    if (!this.#allow(url)) {
      throw new UnexpectedResponseError("An Amazon link pointed away from the storefront.");
    }
    const language = this.storefront.signInLanguage.replace("_", "-");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await this.context.http.request(url, {
        headers: {
          accept: "text/html",
          "accept-language": `${language},${language.slice(0, 2)};q=0.9`,
        },
        jar: this.session.jar,
        allowRedirect: this.#allow,
      });
      if (response.status === 404) {
        return null;
      }
      if (response.status === 200 && looksLikeCaptcha(response.body, response.url)) {
        throw new CaptchaError("Amazon showed a captcha; the source is paused.");
      }
      const signedOut =
        response.status === 401 ||
        response.status === 403 ||
        (response.status === 200 && looksSignedOut(response.body, response.url));
      if (!signedOut) {
        if (response.status !== 200) {
          throw new TransientError(`Amazon answered HTTP ${String(response.status)}.`);
        }
        return { body: response.body, url: response.url };
      }
      if (this.#minted) {
        throw new SignInRejectedError("Amazon asks for a new sign-in.");
      }
      await this.#mint();
    }
    throw new SignInRejectedError("Amazon asks for a new sign-in.");
  }
}

async function readTiles(rules: Rules, reader: StorefrontReader): Promise<OrderTile[] | null> {
  for (const path of ORDERS_PATHS) {
    const page = await reader.page(path);
    if (page !== null) {
      return parseOrderTiles(page.body, (text) => readsAsStatus(rules, text));
    }
  }
  return null;
}

async function loadTrack(
  context: AmazonContext,
  reader: StorefrontReader,
  lead: OrderTile,
): Promise<{ trackPath: string | null; track: TrackPage | null }> {
  let trackPath: string | null = lead.path;
  if (!isTrackPagePath(lead.path)) {
    const line = await reader.page(lead.path);
    trackPath = line === null ? null : parseTrackLink(line.body);
  }
  if (trackPath === null) {
    return { trackPath: null, track: null };
  }
  const page = await reader.page(trackPath);
  const track = page === null ? null : parseTrackPage(page.body);
  if (
    track !== null &&
    track.trackingId === null &&
    track.events.length === 0 &&
    track.shortStatus !== "ORDER_PLACED"
  ) {
    context.reportUnknown("page", "track_page_without_tracking");
  }
  return { trackPath, track };
}

const ordinal = (day: Day): number => Date.UTC(day.year, day.month - 1, day.day);

function deliveredLongAgo(
  rules: Rules,
  lead: OrderTile,
  now: Date,
  storefront: Storefront,
): boolean {
  if (mapStatus(rules, AMAZON_ID, { text: lead.statusText })?.status !== "delivered") {
    return false;
  }
  const day = pastDay(rules, lead.statusText, now, storefront.timeZone);
  const reference = today(now, storefront.timeZone);
  return day !== null && ordinal(reference) - ordinal(day) > DELIVERED_LOOKBACK_DAYS * 86_400_000;
}

function groupTiles(tiles: readonly OrderTile[]): Map<string, OrderTile[]> {
  const groups = new Map<string, OrderTile[]>();
  for (const tile of tiles) {
    if (isSkipped(tile.statusText)) {
      continue;
    }
    const key = shipmentKey(tile);
    groups.set(key, [...(groups.get(key) ?? []), tile]);
  }
  return groups;
}

/** Shipments to load this run: not final yet, oldest read first, capped. */
function pickLoads(
  groups: Map<string, OrderTile[]>,
  session: AmazonSession,
  isOld: (lead: OrderTile) => boolean,
): Set<string> {
  const candidates = [...groups.entries()]
    .filter(
      ([key, tiles]) =>
        session.shipments[key]?.final !== true && !(tiles[0] !== undefined && isOld(tiles[0])),
    )
    .map(([key]) => key)
    .sort((a, b) =>
      (session.shipments[a]?.readAt ?? "").localeCompare(session.shipments[b]?.readAt ?? ""),
    );
  return new Set(candidates.slice(0, MAX_SHIPMENT_LOADS));
}

/** Reads the account's orders and the tracking page of every shipment still moving. */
export async function readAccount(context: AmazonContext, rules: Rules): Promise<FetchResult> {
  const storefront = STOREFRONTS[context.config.storefront];
  const session = loadSession(context.session.load());
  const reader = new StorefrontReader(context, storefront, session);
  try {
    await reader.ensureCookies();
    return await collect(context, rules, storefront, session, reader);
  } finally {
    await context.session.save(serializeSession(session));
  }
}

async function collect(
  context: AmazonContext,
  rules: Rules,
  storefront: Storefront,
  session: AmazonSession,
  reader: StorefrontReader,
): Promise<FetchResult> {
  const tiles = await readTiles(rules, reader);
  if (tiles === null) {
    throw new UnexpectedResponseError("Amazon's orders page was not found.");
  }
  if (tiles.length === 0) {
    // Legitimate for an account without recent orders, but a changed page looks the same; an
    // incomplete result keeps every known parcel instead of concluding they are gone.
    context.reportUnknown("page", "orders_without_lines");
    return { snapshots: [], complete: false };
  }
  const now = context.clock.now();
  const groups = groupTiles(tiles);
  session.shipments = Object.fromEntries(
    Object.entries(session.shipments).filter(([key]) => groups.has(key)),
  );
  const isOld = (lead: OrderTile): boolean => deliveredLongAgo(rules, lead, now, storefront);
  const loads = pickLoads(groups, session, isOld);
  const snapshots: ParcelSnapshot[] = [];
  let complete = true;
  for (const [key, group] of groups) {
    const lead = group[0];
    const remembered = session.shipments[key];
    if (lead === undefined) {
      continue;
    }
    let loaded: { trackPath: string | null; track: TrackPage | null };
    if (loads.has(key)) {
      loaded = await loadTrack(context, reader, lead);
    } else if (remembered !== undefined) {
      loaded = { trackPath: remembered.trackPath, track: recallTrack(remembered.track) };
    } else if (isOld(lead)) {
      loaded = { trackPath: null, track: null };
    } else {
      // Not read yet and over this run's cap: left out, so its barcode never flips later.
      complete = false;
      continue;
    }
    const built = buildSnapshot({
      rules,
      storefront,
      tiles: group,
      ...loaded,
      now,
      report: (kind, value) => {
        context.reportUnknown(kind, value);
      },
    });
    if (built === null) {
      continue;
    }
    snapshots.push(built);
    if (loads.has(key)) {
      session.shipments[key] = {
        readAt: now.toISOString(),
        final: built.delivered && built.deliveredAt !== null,
        trackPath: loaded.trackPath,
        track: rememberTrack(loaded.track),
      };
    }
  }
  return { snapshots, complete };
}
