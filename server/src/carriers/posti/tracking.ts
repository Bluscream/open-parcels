import {
  asObject,
  cleanText,
  isObject,
  isoTime,
  newestFirst,
  num,
  objects,
  readObject,
  rulesStatus,
  snapshot,
  text,
  TransientError,
  UnexpectedResponseError,
  type Json,
  type ParcelSnapshot,
  type ParcelStatus,
  type PluginHttp,
  type SnapshotEvent,
} from "../../plugin/api.js";

export const CARRIER_ID = "posti";
export const AUTH_HOST = "auth-service.posti.fi";
export const GRAPHQL_HOST = "graphql.posti.fi";

const STRINGS = { numbers: false } as const;
const DECIMAL = { decimalComma: true } as const;
const INSTANT = { naive: "utc", epoch: "ms" } as const;

/**
 * Only what the plug-in reads. Pickup PINs, locker ids and sending codes are never requested,
 * so they can never end up in the stored raw payload.
 */
const QUERY = `query ConsumerSearchShipments($code: String!) {
  consumerSearchShipments(page: 1, pageSize: 5, type: PUBLIC_SHIPMENTS, searchTerms: [$code], locale: "en") {
    totalHits
    hits {
      shipmentId
      displayId
      delivery { method result time { type timestamp timestampLatest } destination { name } }
      pickupPoint { type address { publicName city } }
      status { main subStatus exception }
      measurements { weight { unit value } }
      events { city eventDescription reasonDescription timestamp }
    }
  }
}`;

const eventKey = (description: string): string =>
  cleanText(description).toLowerCase().replace(/\.$/, "");

/**
 * Posti's `status.main` values ("main:") and English event texts ("event:") from the shared
 * table. Undefined: not in the table. Null: a notice that says nothing about where the parcel is.
 */
function lookUp(vocabulary: "main" | "event", key: string): ParcelStatus | null | undefined {
  const mapped = rulesStatus(CARRIER_ID, { code: `${vocabulary}:${key}` });
  if (mapped === null) {
    return undefined;
  }
  return mapped.status === "unknown" ? null : mapped.status;
}

interface Tokens {
  readonly authorization: string;
  readonly idToken: string;
}

/** A throwaway anonymous token pair, minted per run and kept in memory only. */
async function mint(http: PluginHttp): Promise<Tokens> {
  const response = await http.request(new URL(`https://${AUTH_HOST}/api/v1/anonymous_token`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}",
  });
  if (response.status !== 200) {
    throw new TransientError(`Posti's anonymous token answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "Posti's anonymous token");
  const anonymous = objects(payload["role_tokens"]).find((role) => role["type"] === "anonymous");
  const authorization = text(anonymous?.["token"], STRINGS);
  const idToken = text(payload["id_token"], STRINGS);
  if (authorization === null || idToken === null) {
    throw new UnexpectedResponseError("Posti's anonymous token answer has no usable token.");
  }
  return { authorization, idToken };
}

/** One search. Null when Posti has no hit; "expired" when it refused the token pair. */
async function search(
  http: PluginHttp,
  tokens: Tokens,
  code: string,
): Promise<Json | null | "expired"> {
  const response = await http.request(new URL(`https://${GRAPHQL_HOST}/graphql`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: tokens.authorization,
      "x-posti-token": `Bearer ${tokens.idToken}`,
    },
    body: JSON.stringify({ query: QUERY, variables: { code } }),
  });
  if (response.status === 401) {
    return "expired";
  }
  if (response.status !== 200) {
    throw new TransientError(`Posti tracking answered HTTP ${response.status}.`);
  }
  const payload = readObject(response, "Posti tracking");
  if (!isObject(payload["data"])) {
    const unauthorized = objects(payload["errors"]).some(
      (error) => error["errorType"] === "Unauthorized",
    );
    if (unauthorized) {
      return "expired";
    }
    throw new UnexpectedResponseError("Posti tracking answered without data.");
  }
  const result = payload["data"]["consumerSearchShipments"];
  if (!isObject(result)) {
    throw new UnexpectedResponseError("Posti tracking answered without search results.");
  }
  const hits = objects(result["hits"]);
  // A free-text search: only a hit that is the code asked for is taken. A single hit is the
  // code's own shipment (an item id finds its shipment); among several, none is guessed.
  const asked = hits.find((hit) =>
    [hit["displayId"], hit["shipmentId"]].some(
      (id) => compact(text(id, STRINGS) ?? "") === compact(code),
    ),
  );
  if (asked !== undefined) {
    return asked;
  }
  return num(result["totalHits"], DECIMAL) === 1 && hits.length === 1 ? (hits[0] ?? null) : null;
}

const compact = (code: string): string => code.replace(/\s+/gu, "").toUpperCase();

/** Looks codes up with one token pair, minting a new one once if Posti refuses it. */
export class PostiTracking {
  #tokens: Tokens | null = null;

  constructor(private readonly http: PluginHttp) {}

  async lookUp(code: string): Promise<Json | null> {
    this.#tokens ??= await mint(this.http);
    let result = await search(this.http, this.#tokens, code);
    if (result === "expired") {
      this.#tokens = await mint(this.http);
      result = await search(this.http, this.#tokens, code);
      if (result === "expired") {
        throw new TransientError("Posti refused a freshly minted anonymous token.");
      }
    }
    return result;
  }
}

function weightKg(measurements: Json): number | null {
  const weight = asObject(measurements["weight"]);
  const value = num(weight["value"], DECIMAL);
  const factor = { kg: 1, g: 0.001 }[String(weight["unit"]).toLowerCase()];
  return value === null || factor === undefined || value <= 0 ? null : value * factor;
}

/** The pickup point named on the newest ready-for-pickup event, else the one Posti lists. */
function pickupPoint(events: readonly Json[], point: Json): string | null {
  const ready = events.find(
    (event) =>
      lookUp("event", eventKey(text(event["eventDescription"], STRINGS) ?? "")) ===
      "at_pickup_point",
  );
  return ready === undefined
    ? text(asObject(point["address"])["publicName"], STRINGS)
    : text(ready["city"], STRINGS);
}

function receiver(delivery: Json): string | null {
  const name = asObject(delivery["destination"])["name"];
  const parts = Array.isArray(name)
    ? name.map((part) => text(part, STRINGS)).filter((part) => part !== null)
    : [text(name, STRINGS)];
  const joined = parts.filter((part) => part !== null).join(", ");
  return joined === "" ? null : joined;
}

export function trackingSnapshot(
  raw: Json,
  code: string,
  report: (kind: string, key: string) => void,
): ParcelSnapshot {
  const events = objects(raw["events"]);
  const entries: SnapshotEvent[] = [];
  for (const event of events) {
    const at = isoTime(event["timestamp"], INSTANT);
    const description = text(event["eventDescription"], STRINGS);
    if (at === null || description === null) {
      continue;
    }
    const key = eventKey(description);
    const mapped = lookUp("event", key);
    if (mapped === undefined) {
      report("event_text", key);
    }
    entries.push({
      at,
      status: mapped ?? null,
      rawStatus: description,
      location: text(event["city"], STRINGS),
    });
  }
  const history = newestFirst(entries);
  const main = text(asObject(raw["status"])["main"], STRINGS);
  const mainStatus = main === null ? undefined : (lookUp("main", main) ?? undefined);
  if (main !== null && mainStatus === undefined) {
    report("status_code", main);
  }
  // `status.main` is decisive when known; otherwise the newest event that says where it is.
  const status = mainStatus ?? history.find((event) => event.status !== null)?.status ?? null;
  const delivered = status === "delivered";
  const time = asObject(asObject(raw["delivery"])["time"]);
  const plannedFrom = delivered ? null : isoTime(time["timestamp"], INSTANT);
  return snapshot({
    carrier: CARRIER_ID,
    barcode: code,
    status,
    rawStatus: main ?? history[0]?.rawStatus ?? null,
    delivered,
    deliveredAt: delivered ? (history[0]?.at ?? null) : null,
    plannedFrom,
    plannedTo: plannedFrom === null ? null : isoTime(time["timestampLatest"], INSTANT),
    pickup: status === "at_pickup_point",
    pickupPoint: pickupPoint(events, asObject(raw["pickupPoint"])),
    url: `https://www.posti.fi/seuranta/${encodeURIComponent(code)}`,
    receiver: receiver(asObject(raw["delivery"])),
    weightKg: weightKg(asObject(raw["measurements"])),
    history,
    raw,
  });
}
