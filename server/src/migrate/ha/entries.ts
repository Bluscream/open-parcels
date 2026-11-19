import { z } from "zod";
import type { SourceKind } from "../../engine/sources.js";

/**
 * Turns the config entries of the Home Assistant parcel suite into open-parcels source plans.
 * Pure: reads the parsed `core.config_entries` file, touches no database. `apply.ts` writes the
 * plans.
 */

/** One config entry, as the importer needs it. */
export interface HaEntry {
  readonly entryId: string;
  readonly domain: string;
  readonly title: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly options: Readonly<Record<string, unknown>>;
  readonly disabled: boolean;
}

export interface ParcelPlan {
  readonly barcode: string;
  readonly direction: "incoming" | "outgoing";
}

/** Where an entry's codes are tracked: by the entry's own source, or by DHL's tracking source. */
export type ParcelTarget = "self" | "dhl_tracking";

export interface SourcePlan {
  readonly entryId: string;
  readonly domain: string;
  readonly plugin: string;
  readonly kind: SourceKind;
  /** The HA entry title, so the HA integration's devices keep their names and entity ids. */
  readonly label: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Encrypted into `secret_blob`; null when the source needs none. */
  readonly secret: unknown;
  /** Encrypted into `session_blob`; null when there is nothing to carry over. */
  readonly session: unknown;
  readonly state: "ok" | "needs_sign_in";
  readonly stateDetail: string | null;
  readonly parcels: readonly ParcelPlan[];
  readonly parcelTarget: ParcelTarget;
  /** HA settings with no open-parcels equivalent: names only, never values. */
  readonly notCarriedOver: readonly string[];
}

export type EntryPlan =
  | { readonly type: "source"; readonly plan: SourcePlan }
  | { readonly type: "covered"; readonly entry: HaEntry; readonly reason: string }
  | { readonly type: "skipped"; readonly entry: HaEntry; readonly reason: string }
  | { readonly type: "unrecognised"; readonly entry: HaEntry };

const entrySchema = z.object({
  entry_id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().nullish(),
  data: z.record(z.string(), z.unknown()).nullish(),
  options: z.record(z.string(), z.unknown()).nullish(),
  disabled_by: z.string().nullish(),
});

const fileSchema = z.object({
  data: z.object({ entries: z.array(z.unknown()) }),
});

/** The entries of HA's `.storage/core.config_entries`; entries without an id are dropped. */
export function parseConfigEntries(raw: unknown): HaEntry[] {
  const file = fileSchema.safeParse(raw);
  if (!file.success) {
    throw new Error("This is not Home Assistant's core.config_entries file (no data.entries).");
  }
  const entries: HaEntry[] = [];
  for (const item of file.data.data.entries) {
    const parsed = entrySchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }
    const entry = parsed.data;
    entries.push({
      entryId: entry.entry_id,
      domain: entry.domain,
      title: entry.title ?? "",
      data: entry.data ?? {},
      options: entry.options ?? {},
      disabled: entry.disabled_by !== null && entry.disabled_by !== undefined,
    });
  }
  return entries;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Retention, history and polling settings the engine handles on its own terms. */
const ENGINE_OPTIONS = [
  "delivered_filter_type",
  "delivered_filter_amount",
  "include_history",
  "live_tracking",
  "hand_off",
];

function notCarried(options: Readonly<Record<string, unknown>>, keys: readonly string[]): string[] {
  return keys.filter((key) => key in options).sort();
}

/** Codes from a list of strings or of `{<key>: code, direction?}` objects; duplicates dropped. */
function codes(value: unknown, key: string): ParcelPlan[] {
  const seen = new Map<string, ParcelPlan>();
  for (const item of Array.isArray(value) ? value : []) {
    const record =
      item !== null && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const barcode = text(record === null ? item : record[key])
      ?.replace(/\s+/g, "")
      .toUpperCase();
    if (barcode === undefined || seen.has(barcode)) {
      continue;
    }
    const direction = record?.["direction"] === "outgoing" ? "outgoing" : "incoming";
    seen.set(barcode, { barcode, direction });
  }
  return [...seen.values()];
}

type Base = Pick<SourcePlan, "entryId" | "domain" | "label">;

function base(entry: HaEntry, fallback: string): Base {
  return { entryId: entry.entryId, domain: entry.domain, label: entry.title || fallback };
}

function signedIn(): Pick<SourcePlan, "state" | "stateDetail"> {
  return { state: "ok", stateDetail: null };
}

function needsSignIn(detail: string): Pick<SourcePlan, "state" | "stateDetail"> {
  return { state: "needs_sign_in", stateDetail: detail };
}

/** Storefronts the `amazon` plug-in reads; kept here so the importer needs no plug-in import. */
const AMAZON_STOREFRONTS: ReadonlySet<string> = new Set([
  "amazon.de",
  "amazon.co.uk",
  "amazon.com",
  "amazon.ie",
  "amazon.ca",
  "amazon.com.au",
  "amazon.in",
]);

function amazonPlan(entry: HaEntry): EntryPlan {
  const storefront = text(entry.data["country"])?.toLowerCase() ?? null;
  if (storefront === null || !AMAZON_STOREFRONTS.has(storefront)) {
    return {
      type: "skipped",
      entry,
      reason: `The amazon plug-in does not read the storefront ${storefront ?? "(none)"} yet.`,
    };
  }
  const refreshToken = text(entry.data["refresh_token"]);
  const deviceSerial = text(entry.data["device_serial"])?.toUpperCase() ?? null;
  const usable =
    refreshToken !== null && deviceSerial !== null && /^[0-9A-F]{32}$/.test(deviceSerial);
  return {
    type: "source",
    plan: {
      ...base(entry, `Amazon (${storefront})`),
      plugin: "amazon",
      kind: "shop",
      config: { storefront },
      secret: usable ? { refreshToken, deviceSerial } : null,
      session: null,
      ...(usable
        ? signedIn()
        : needsSignIn("The Home Assistant entry holds no usable device registration; sign in.")),
      parcels: [],
      parcelTarget: "self",
      notCarriedOver: notCarried(entry.options, ENGINE_OPTIONS),
    },
  };
}

function dhlAccountPlan(entry: HaEntry): EntryPlan {
  const country = text(entry.data["country"])?.toUpperCase() ?? "DE";
  const parcels = codes(entry.options["tracked_codes"], "tracking_code");
  const common = {
    plugin: "dhl",
    kind: "account" as const,
    session: null,
    parcels,
    parcelTarget: "dhl_tracking" as const,
    notCarriedOver: notCarried(entry.options, ENGINE_OPTIONS),
  };
  if (country === "PL") {
    return {
      type: "source",
      plan: {
        ...base(entry, "Poland"),
        ...common,
        config: { account: "pl" },
        secret: null,
        ...needsSignIn("The Mój DHL session from Home Assistant cannot be carried over; sign in."),
        notCarriedOver: [...common.notCarriedOver, "pl_cookies", "pl_device_id"].sort(),
      },
    };
  }
  if (country !== "DE") {
    return { type: "skipped", entry, reason: `No DHL account source for the country ${country}.` };
  }
  const refreshToken = text(entry.data["refresh_token"]);
  return {
    type: "source",
    plan: {
      ...base(entry, "Germany"),
      ...common,
      config: { account: "de" },
      secret: refreshToken === null ? null : { refreshToken },
      ...(refreshToken === null
        ? needsSignIn("The Home Assistant entry holds no DHL refresh token; sign in.")
        : signedIn()),
    },
  };
}

function dhlPlan(entry: HaEntry): EntryPlan {
  const source = text(entry.data["source"]) ?? "account";
  if (source === "account") {
    return dhlAccountPlan(entry);
  }
  if (source !== "tracking") {
    return {
      type: "skipped",
      entry,
      reason: `DHL "${source}" entries are not imported; add the source by hand.`,
    };
  }
  return {
    type: "source",
    plan: {
      ...base(entry, "DHL tracking"),
      plugin: "dhl",
      kind: "tracking",
      config: {},
      secret: null,
      session: null,
      ...signedIn(),
      parcels: codes(entry.options["parcels"], "tracking_code"),
      parcelTarget: "self",
      notCarriedOver: notCarried(entry.options, ENGINE_OPTIONS),
    },
  };
}

function glsSession(entry: HaEntry, country: string): unknown {
  const instanceId = text(entry.data["de_app_instance_id"]);
  if (country !== "DE" || instanceId === null) {
    return null;
  }
  // The parcel numbers GLS Germany assigned, so adding a known code again never hits its 409.
  const parcels: Record<string, string> = {};
  for (const item of Array.isArray(entry.options["parcels"]) ? entry.options["parcels"] : []) {
    const record =
      item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const code = text(record["parcel_no"])?.replace(/\s+/g, "").toUpperCase();
    const number = text(record["de_parcel_number"]);
    if (code !== undefined && number !== null) {
      parcels[code] = number;
    }
  }
  // Token null: the next run validates the instance and gets a fresh token, registering nothing.
  return { de: { instanceId, token: null, expiresAt: null, parcels } };
}

function glsPlan(entry: HaEntry): EntryPlan {
  const country = text(entry.options["country"] ?? entry.data["country"])?.toUpperCase() ?? "NL";
  const postalCode = text(entry.options["postal_code"] ?? entry.data["postal_code"]);
  if (postalCode === null) {
    return { type: "skipped", entry, reason: "The GLS entry has no postcode." };
  }
  const parcels = codes(entry.options["parcels"], "parcel_no");
  const postcodes = new Set<string>();
  for (const item of Array.isArray(entry.options["parcels"]) ? entry.options["parcels"] : []) {
    const own = item !== null && typeof item === "object" ? (item as Record<string, unknown>) : {};
    postcodes.add(text(own["postal_code"]) ?? postalCode);
  }
  const extra = postcodes.size > 1 ? ["per-parcel postal_code"] : [];
  return {
    type: "source",
    plan: {
      ...base(entry, `GLS ${country}`),
      plugin: "gls",
      kind: "tracking",
      config: { country, postalCode },
      secret: null,
      session: glsSession(entry, country),
      ...signedIn(),
      parcels,
      parcelTarget: "self",
      notCarriedOver: [...notCarried(entry.options, ENGINE_OPTIONS), ...extra],
    },
  };
}

function hermesPlan(entry: HaEntry): EntryPlan {
  const source = text(entry.data["source"]) ?? "account";
  const common = {
    plugin: "hermes",
    config: {},
    parcelTarget: "self" as const,
    notCarriedOver: notCarried(entry.options, ENGINE_OPTIONS),
  };
  if (source === "tracking") {
    return {
      type: "source",
      plan: {
        ...base(entry, "Hermes"),
        ...common,
        kind: "tracking",
        secret: null,
        session: null,
        ...signedIn(),
        parcels: codes(entry.options["parcels"], "tracking_code"),
      },
    };
  }
  const username = text(entry.data["username"]);
  const accessToken = text(entry.data["access_token"]);
  const refreshToken = text(entry.data["refresh_token"]);
  const tokens =
    accessToken === null || refreshToken === null ? null : { accessToken, refreshToken };
  const usable = username !== null && tokens !== null;
  return {
    type: "source",
    plan: {
      ...base(entry, "Hermes account"),
      ...common,
      kind: "account",
      // No password: HA never stored one. The tokens carry the source until Hermes refuses them.
      secret: username === null ? null : { username },
      session: usable ? tokens : null,
      ...(usable
        ? signedIn()
        : needsSignIn("Credentials missing: the Home Assistant entry holds no Hermes tokens.")),
      parcels: [],
    },
  };
}

/** The plan for one entry. */
export function planEntry(entry: HaEntry): EntryPlan {
  if (entry.disabled) {
    return { type: "skipped", entry, reason: "Disabled in Home Assistant." };
  }
  switch (entry.domain) {
    case "amazon_orders":
      return amazonPlan(entry);
    case "dhl":
      return dhlPlan(entry);
    case "gls":
      return glsPlan(entry);
    case "hermes":
      return hermesPlan(entry);
    case "parcel_aggregator":
      return {
        type: "covered",
        entry,
        reason: "The open-parcels engine aggregates parcels itself.",
      };
    default:
      return { type: "unrecognised", entry };
  }
}
