import { createHash } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod";
import { isoNow, type Clock } from "../../clock.js";
import type { SecretBox } from "../../crypto/secrets.js";
import type { Database } from "../../db/schema.js";
import { BUILTIN_CARRIERS } from "../../engine/builtin-carriers.js";
import { trackingSourceIn } from "../../engine/linking.js";
import { PluginRegistry } from "../../engine/registry.js";
import { secretAad, sessionAad } from "../../engine/sources.js";
import { parseConfigEntries, planEntry, type SourcePlan } from "./entries.js";

/**
 * Imports the Home Assistant parcel suite's config entries as sources, signed in where the stored
 * tokens allow. Idempotent: each HA entry leaves a marker in `settings`, so a re-run updates the
 * source it created instead of adding another. The report holds labels and counts, never secrets.
 */

export interface HaSourceReport {
  readonly entryId: string;
  readonly domain: string;
  readonly label: string;
  readonly plugin: string;
  readonly kind: string;
  readonly action: "created" | "updated";
  readonly state: "ok" | "needs_sign_in";
  readonly stateDetail: string | null;
  /** True when sign-in data was carried over (never the data itself). */
  readonly signedIn: boolean;
  /** False on a re-run whose HA sign-in data was unchanged, so newer tokens were kept. */
  readonly credentialsWritten: boolean;
  readonly parcels: number;
  readonly notCarriedOver: readonly string[];
}

export interface HaEntryNote {
  readonly entryId: string;
  readonly domain: string;
  readonly title: string;
  readonly reason: string;
}

export interface HaImportReport {
  readonly dryRun: boolean;
  readonly sources: readonly HaSourceReport[];
  readonly parcels: { readonly created: number; readonly existing: number };
  readonly covered: readonly HaEntryNote[];
  readonly skipped: readonly HaEntryNote[];
  /** Entries of integrations this importer does not know, counted per domain. */
  readonly unrecognised: Readonly<Record<string, number>>;
}

export interface HaImportOptions {
  /** The parsed contents of HA's `.storage/core.config_entries`. */
  readonly configEntries: unknown;
  readonly db: Kysely<Database>;
  readonly secrets: SecretBox;
  readonly clock: Clock;
  readonly dryRun: boolean;
}

class DryRunRollback extends Error {
  override readonly name = "DryRunRollback";
}

export const markerKey = (entryId: string): string => `ha_import:${entryId}`;

/** `adopted`: the entry was mapped onto a source that existed before; it is never rewritten. */
const markerSchema = z.object({
  sourceId: z.string(),
  credentials: z.string(),
  adopted: z.boolean().optional(),
});
type Marker = z.infer<typeof markerSchema>;

/** A fingerprint of the sign-in data as HA had it, to tell a changed HA entry from a re-run. */
function credentialsFingerprint(plan: SourcePlan): string {
  return createHash("sha256")
    .update(JSON.stringify({ secret: plan.secret, session: plan.session }))
    .digest("hex")
    .slice(0, 16);
}

async function readMarker(trx: Transaction<Database>, entryId: string): Promise<Marker | null> {
  const row = await trx
    .selectFrom("settings")
    .select("value")
    .where("key", "=", markerKey(entryId))
    .executeTakeFirst();
  if (row === undefined) {
    return null;
  }
  const parsed = markerSchema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : null;
}

interface Context {
  readonly trx: Transaction<Database>;
  readonly secrets: SecretBox;
  readonly now: string;
}

async function writeMarker(ctx: Context, entryId: string, marker: Marker): Promise<void> {
  const value = JSON.stringify(marker);
  await ctx.trx
    .insertInto("settings")
    .values({ key: markerKey(entryId), value, updated_at: ctx.now })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value, updated_at: ctx.now }))
    .execute();
}

interface Written {
  readonly id: string;
  readonly action: "created" | "updated";
  readonly credentialsWritten: boolean;
}

function blobs(ctx: Context, id: string, plan: SourcePlan) {
  return {
    secret_blob: plan.secret === null ? null : ctx.secrets.encryptJson(plan.secret, secretAad(id)),
    session_blob:
      plan.session === null ? null : ctx.secrets.encryptJson(plan.session, sessionAad(id)),
    state: plan.state,
    state_detail: plan.stateDetail,
  };
}

/** Creates the plan's source, or updates the one an earlier run created for the same HA entry. */
async function writeSource(ctx: Context, plan: SourcePlan): Promise<Written> {
  const fingerprint = credentialsFingerprint(plan);
  const marker = await readMarker(ctx.trx, plan.entryId);
  const existing =
    marker === null
      ? undefined
      : await ctx.trx
          .selectFrom("sources")
          .select(["id", "plugin"])
          .where("id", "=", marker.sourceId)
          .executeTakeFirst();
  if (marker?.adopted === true && existing?.plugin === plan.plugin) {
    return { id: existing.id, action: "updated", credentialsWritten: false };
  }
  // A keyless tracking source holds nothing of its own: adopt the plug-in's existing one (created
  // on first use, say) instead of adding a second, keeping that source's id and label.
  const adopted =
    existing === undefined && plan.kind === "tracking" && plan.secret === null
      ? await ctx.trx
          .selectFrom("sources")
          .select(["id", "plugin"])
          .where("plugin", "=", plan.plugin)
          .where("kind", "=", "tracking")
          .where("secret_blob", "is", null)
          .orderBy("created_at")
          .executeTakeFirst()
      : undefined;
  if (adopted !== undefined) {
    await writeMarker(ctx, plan.entryId, {
      sourceId: adopted.id,
      credentials: fingerprint,
      adopted: true,
    });
    return { id: adopted.id, action: "updated", credentialsWritten: false };
  }
  if (marker !== null && existing?.plugin === plan.plugin) {
    // Same HA sign-in as last time: the source may have rotated its tokens since, so keep them.
    const fresh = marker.credentials !== fingerprint;
    await ctx.trx
      .updateTable("sources")
      .set({
        label: plan.label,
        config: JSON.stringify(plan.config),
        ...(fresh ? { ...blobs(ctx, existing.id, plan), next_run_at: ctx.now } : {}),
        updated_at: ctx.now,
      })
      .where("id", "=", existing.id)
      .execute();
    await writeMarker(ctx, plan.entryId, { sourceId: existing.id, credentials: fingerprint });
    return { id: existing.id, action: "updated", credentialsWritten: fresh };
  }
  const id = crypto.randomUUID();
  await ctx.trx
    .insertInto("sources")
    .values({
      id,
      plugin: plan.plugin,
      kind: plan.kind,
      label: plan.label,
      config: JSON.stringify(plan.config),
      ...blobs(ctx, id, plan),
      next_run_at: plan.state === "ok" ? ctx.now : null,
      created_at: ctx.now,
      updated_at: ctx.now,
    })
    .execute();
  await writeMarker(ctx, plan.entryId, { sourceId: id, credentials: fingerprint });
  return { id, action: "created", credentialsWritten: true };
}

interface ParcelCounts {
  created: number;
  existing: number;
}

/** Adds the codes as parcels (once per carrier and code) and links them to `sourceId`. */
async function writeParcels(
  ctx: Context,
  plan: SourcePlan,
  sourceId: string,
  counts: ParcelCounts,
): Promise<void> {
  for (const parcel of plan.parcels) {
    const found = await ctx.trx
      .selectFrom("parcels")
      .select("id")
      .where("carrier", "=", plan.plugin)
      .where("barcode", "=", parcel.barcode)
      .where("removed_at", "is", null)
      .executeTakeFirst();
    const id = found?.id ?? crypto.randomUUID();
    if (found === undefined) {
      await ctx.trx
        .insertInto("parcels")
        .values({
          id,
          carrier: plan.plugin,
          barcode: parcel.barcode,
          direction: parcel.direction,
          status: "unknown",
          raw_status: null,
          delivered: 0,
          delivered_at: null,
          planned_from: null,
          planned_to: null,
          pickup: 0,
          label: null,
          order_id: null,
          manual_status: null,
          first_seen_at: ctx.now,
          last_seen_at: ctx.now,
          updated_at: ctx.now,
        })
        .execute();
      counts.created += 1;
    } else {
      counts.existing += 1;
    }
    await ctx.trx
      .insertInto("parcel_sources")
      .values({
        parcel_id: id,
        source_id: sourceId,
        external_ref: null,
        role: "primary",
        last_seen_at: ctx.now,
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

function note(entry: { entryId: string; domain: string; title: string }, reason: string) {
  return { entryId: entry.entryId, domain: entry.domain, title: entry.title, reason };
}

/** Tracking entries first, so DHL account codes go to the imported "DHL tracking" source. */
function order(plans: readonly SourcePlan[]): SourcePlan[] {
  return [...plans].sort((a, b) => Number(b.kind === "tracking") - Number(a.kind === "tracking"));
}

async function importPlans(
  trx: Transaction<Database>,
  options: HaImportOptions,
  plans: readonly SourcePlan[],
  counts: ParcelCounts,
): Promise<HaSourceReport[]> {
  const ctx: Context = { trx, secrets: options.secrets, now: isoNow(options.clock) };
  const trackingFor = trackingSourceIn(trx, new PluginRegistry(BUILTIN_CARRIERS), options.clock);
  let dhlTracking: string | undefined;
  const reports: HaSourceReport[] = [];
  for (const plan of order(plans)) {
    const written = await writeSource(ctx, plan);
    if (plan.plugin === "dhl" && plan.kind === "tracking") {
      dhlTracking ??= written.id;
    }
    if (plan.parcels.length > 0) {
      const target =
        plan.parcelTarget === "self" ? written.id : (dhlTracking ??= await trackingFor("dhl"));
      if (target !== undefined) {
        await writeParcels(ctx, plan, target, counts);
      }
    }
    reports.push({
      entryId: plan.entryId,
      domain: plan.domain,
      label: plan.label,
      plugin: plan.plugin,
      kind: plan.kind,
      action: written.action,
      state: plan.state,
      stateDetail: plan.stateDetail,
      signedIn: plan.state === "ok" && (plan.secret !== null || plan.session !== null),
      credentialsWritten: written.credentialsWritten,
      parcels: plan.parcels.length,
      notCarriedOver: plan.notCarriedOver,
    });
  }
  return reports;
}

/**
 * Runs the import. A dry run does the whole import in a transaction and rolls it back, so it
 * checks everything it would write.
 */
export async function importHaEntries(options: HaImportOptions): Promise<HaImportReport> {
  const plans: SourcePlan[] = [];
  const covered: HaEntryNote[] = [];
  const skipped: HaEntryNote[] = [];
  const unrecognised: Record<string, number> = {};
  for (const entry of parseConfigEntries(options.configEntries)) {
    const plan = planEntry(entry);
    if (plan.type === "source") {
      plans.push(plan.plan);
    } else if (plan.type === "covered") {
      covered.push(note(entry, plan.reason));
    } else if (plan.type === "skipped") {
      skipped.push(note(entry, plan.reason));
    } else {
      unrecognised[entry.domain] = (unrecognised[entry.domain] ?? 0) + 1;
    }
  }
  const counts: ParcelCounts = { created: 0, existing: 0 };
  let sources: HaSourceReport[] = [];
  try {
    await options.db.transaction().execute(async (trx) => {
      sources = await importPlans(trx, options, plans, counts);
      if (options.dryRun) {
        throw new DryRunRollback("Dry run: rolling back.");
      }
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) {
      throw error;
    }
  }
  return {
    dryRun: options.dryRun,
    sources,
    parcels: counts,
    covered,
    skipped,
    unrecognised,
  };
}
