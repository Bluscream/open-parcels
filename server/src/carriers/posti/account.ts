import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  asObject,
  isObject,
  num,
  objects,
  readObject,
  text,
  type FetchResult,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { claims, refreshWithDevice, type Tokens } from "./device.js";
import type { PostiSecret } from "./login.js";
import { GRAPHQL_HOST } from "./tracking.js";

/** Renew this long before the ID token's own expiry. */
const MARGIN_SECONDS = 300;
/** One page holds the whole account, so a shipment moving between pages cannot be missed. */
const PAGE_SIZE = 1000;
/** Only fields the anonymous route resolves too; an unknown field fails the whole query. */
const QUERY = `query GetConsumerShipments($page: Int!, $pageSize: Int!, $locale: String) {
  consumerShipments(page: $page, pageSize: $pageSize, locale: $locale) {
    page
    totalPages
    hits {
      shipmentId
      userRole
      displayId
      displayName
      delivery { time { timestamp } destination { name city } }
      pickupPoint { address { publicName city } }
      status { main }
      measurements { weight { value } }
      events { city eventDescription timestamp }
    }
  }
}`;

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "clock" | "session" | "reportUnknown">;
export type ToSnapshot = (raw: Json, code: string) => ParcelSnapshot;

/** The tokens currently in use: renewed ones from the session, else those of the sign-in. */
function current(deps: Deps, secret: PostiSecret): Tokens {
  const saved = asObject(deps.session.load());
  const idToken = text(saved["idToken"]);
  return saved["device"] === secret.device.deviceId && idToken !== null
    ? { idToken, roleTokens: objects(saved["roleTokens"]) }
    : { idToken: secret.idToken, roleTokens: secret.roleTokens };
}

function expiresSoon(idToken: string, nowMs: number): boolean {
  const exp = num(claims(idToken)["exp"], { strings: false });
  return exp === null || exp * 1000 - nowMs < MARGIN_SECONDS * 1000;
}

async function renewed(deps: Deps, secret: PostiSecret, tokens: Tokens): Promise<Tokens> {
  const fresh = await refreshWithDevice(deps.http, deps.clock, secret.device, tokens.idToken);
  // The answer may leave the role tokens out; those stay as they were.
  const next = {
    idToken: fresh.idToken,
    roleTokens: fresh.roleTokens.length > 0 ? fresh.roleTokens : tokens.roleTokens,
  };
  await deps.session.save({ device: secret.device.deviceId, ...next });
  return next;
}

/** One page, or "refused" when Posti turned the ID token or the consumer role down. */
async function page(
  deps: Deps,
  tokens: Tokens,
  number: number,
): Promise<{ hits: Json[]; pages: number } | "refused"> {
  const role = tokens.roleTokens.find((item) => item["type"] === "consumer");
  const roleToken = text(role?.["token"], { numbers: false });
  if (roleToken === null) {
    return "refused";
  }
  const response = await deps.http.request(new URL(`https://${GRAPHQL_HOST}/graphql`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: roleToken,
      "x-posti-token": `Bearer ${tokens.idToken}`,
    },
    body: JSON.stringify({
      operationName: "GetConsumerShipments",
      variables: { page: number, pageSize: PAGE_SIZE, locale: "en" },
      query: QUERY,
    }),
  });
  if (response.status === 401) {
    return "refused";
  }
  if (response.status !== 200) {
    throw new TransientError(`Posti's account answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "Posti's account");
  const found = asObject(payload["data"])["consumerShipments"];
  if (!isObject(found) || !Array.isArray(found["hits"])) {
    // An expired ID token answers 200 with this error; any other error is no sign-in problem.
    const unauthorized = objects(payload["errors"]).some((e) => e["errorType"] === "Unauthorized");
    if (unauthorized) {
      return "refused";
    }
    throw new UnexpectedResponseError("Posti's account answered without shipments.");
  }
  return { hits: objects(found["hits"]), pages: num(found["totalPages"], { strings: false }) ?? 1 };
}

async function allPages(deps: Deps, tokens: Tokens): Promise<Json[] | "refused"> {
  const hits: Json[] = [];
  for (let number = 1, pages = 1; number <= pages; number += 1) {
    const result = await page(deps, tokens, number);
    if (result === "refused") {
      return result;
    }
    hits.push(...result.hits);
    pages = result.pages;
  }
  return hits;
}

/**
 * Every shipment of the account, received and sent. Tokens are renewed with the device shortly
 * before they expire and once after a refusal; a second refusal asks for a new login.
 */
export async function fetchPostiAccount(
  deps: Deps,
  secret: PostiSecret,
  toSnapshot: ToSnapshot,
): Promise<FetchResult> {
  let tokens = current(deps, secret);
  if (expiresSoon(tokens.idToken, deps.clock.now().getTime())) {
    tokens = await renewed(deps, secret, tokens);
  }
  let hits = await allPages(deps, tokens);
  if (hits === "refused") {
    tokens = await renewed(deps, secret, tokens);
    hits = await allPages(deps, tokens);
    if (hits === "refused") {
      throw new SignInRejectedError("Posti refused freshly renewed tokens.");
    }
  }
  const snapshots: ParcelSnapshot[] = [];
  for (const hit of hits) {
    const code = text(hit["displayId"]) ?? text(hit["shipmentId"]);
    if (code === null) {
      continue;
    }
    const outgoing = hit["userRole"] === "SENDER";
    const other = text(hit["displayName"]);
    const parcel = toSnapshot(hit, code);
    snapshots.push({
      ...parcel,
      direction: outgoing ? "outgoing" : "incoming",
      // displayName is the other party: the sender of a received shipment, the receiver of a sent one.
      sender: outgoing ? null : other,
      receiver: outgoing ? other : parcel.receiver,
    });
  }
  return { snapshots, complete: true };
}
