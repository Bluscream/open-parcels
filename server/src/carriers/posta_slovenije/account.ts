import {
  SignInRejectedError,
  UnexpectedResponseError,
  asArray,
  isObject,
  type Json,
  type ParcelSnapshot,
  type PluginHttp,
} from "../../plugin/api.js";
import type { TokenKeeper } from "./auth.js";
import { scanSnapshot } from "./scans.js";
import { API_BASE, getJson, parcelOf, resultOf, text, type Answer } from "./shared.js";

const PAGE_SIZE = 10;
const MAX_PAGES = 20;
/** At most this many detail calls per run; archived parcels never get one. */
export const DETAIL_LIMIT = 25;

/**
 * A signed-in GET. The first 401 renews the token (refresh, else password), a second signs in
 * with the password, a third means the account no longer works. Network errors propagate and
 * never lead to a sign-in.
 */
async function signedGet(http: PluginHttp, keeper: TokenKeeper, url: URL): Promise<Answer> {
  let token = await keeper.current();
  for (let stage = 0; stage < 3; stage += 1) {
    const answer = await getJson(http, url, { authorization: `Bearer ${token}` });
    if (answer.status !== 401) {
      return answer;
    }
    if (stage === 2) {
      break;
    }
    token = await keeper.renew(stage === 0);
  }
  throw new SignInRejectedError("MojaPošta keeps refusing a fresh sign-in.");
}

type Direction = ParcelSnapshot["direction"];

/** Every row of one list, paged until `totalCount` is reached. */
async function inbox(http: PluginHttp, keeper: TokenKeeper, direction: Direction): Promise<Json[]> {
  const rows = new Map<string, Json>();
  let skipped = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(API_BASE);
    url.search = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      [direction]: "true",
    }).toString();
    const result = resultOf(await signedGet(http, keeper, url));
    const total = result["totalCount"];
    if (!Array.isArray(result["items"]) || typeof total !== "number") {
      throw new UnexpectedResponseError("MojaPošta's parcel list has an unexpected shape.");
    }
    const items = asArray(result["items"]);
    for (const item of items) {
      const id = isObject(item) ? item["parcelId"] : undefined;
      if (
        !isObject(item) ||
        (typeof id !== "string" && typeof id !== "number") ||
        text(item["trackingNumber"]) === null
      ) {
        skipped += 1;
        continue;
      }
      if (!rows.has(String(id))) {
        rows.set(String(id), item);
      }
    }
    if (rows.size + skipped >= total) {
      return [...rows.values()];
    }
    if (items.length === 0) {
      break;
    }
  }
  throw new UnexpectedResponseError("MojaPošta's parcel list ended before its total.");
}

async function detail(http: PluginHttp, keeper: TokenKeeper, id: string): Promise<Json | null> {
  const answer = await signedGet(http, keeper, new URL(`${API_BASE}/${encodeURIComponent(id)}`));
  return answer.status === 404 ? null : resultOf(answer);
}

/** The direction the detail or the row states; the list it came from otherwise. */
function directionOf(row: Json, result: Json | null, listed: Direction): Direction {
  const flag = result?.["isOutgoingParcel"] ?? row["isOutgoingParcel"];
  if (typeof flag !== "boolean") {
    return listed;
  }
  return flag ? "outgoing" : "incoming";
}

/** Both lists, with the scan history of each live parcel from its detail. */
export async function readAccount(
  http: PluginHttp,
  keeper: TokenKeeper,
  report: (code: string) => void,
): Promise<ParcelSnapshot[]> {
  const snapshots: ParcelSnapshot[] = [];
  const seen = new Set<string>();
  let details = 0;
  for (const listed of ["incoming", "outgoing"] as const) {
    for (const row of await inbox(http, keeper, listed)) {
      const id = String(row["parcelId"]);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const wantDetail =
        row["isArchived"] !== true && !Array.isArray(row["statuses"]) && details < DETAIL_LIMIT;
      details += wantDetail ? 1 : 0;
      const result = wantDetail ? await detail(http, keeper, id) : null;
      const parcel = result === null ? {} : parcelOf(result);
      snapshots.push(
        scanSnapshot(
          {
            barcode: text(row["trackingNumber"]) ?? id,
            statuses: result?.["statuses"] ?? row["statuses"],
            direction: directionOf(row, result, listed),
            sender: text(row["senderName"]) ?? text(parcel["senderName"]),
            receiver: text(row["receiverName"]) ?? text(parcel["receiverName"]),
            raw: { inbox: row, detail: result },
          },
          report,
        ),
      );
    }
  }
  return snapshots;
}
