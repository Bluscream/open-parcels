import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { SecretBox } from "../crypto/secrets.js";
import type { Database, SourceRow } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { MAIL_PLUGIN, mailConfigSchema, mailSecretSchema } from "../mail/types.js";
import {
  linkUntrackedParcels,
  trackingSourceIn,
  type LinkOptions,
  type LinkResult,
} from "./linking.js";
import { InvalidSourceConfigError, type PluginRegistry } from "./registry.js";

export type SourceKind = SourceRow["kind"];
export type SourceState = SourceRow["state"];

/** Details of a source no run has judged yet. */
export const NOT_SIGNED_IN_YET = "Not signed in yet.";
export const NOT_RUN_YET = "Not run yet.";

/**
 * Writes `source.removed` inside the caller's transaction. `mergedInto` names the source that
 * took over the removed one's parcels, when it was merged rather than deleted.
 */
export async function appendSourceRemoved(
  trx: Kysely<Database>,
  clock: Clock,
  source: { id: string; plugin: string; label: string; kind: SourceKind },
  mergedInto: string | null,
): Promise<void> {
  await appendEvent(trx, clock, {
    type: "source.removed",
    parcelId: null,
    payload: {
      source: { id: source.id, plugin: source.plugin, label: source.label, kind: source.kind },
      merged_into: mergedInto,
    },
  });
}

/**
 * Removes those of `sourceIds` that the app created on its own (keyless tracking sources made
 * when a code was added by hand) and that no parcel links to any more, firing `source.removed`
 * for each inside the caller's transaction. Sources the user made or imported are never touched,
 * and neither is one that has gained sign-in data since. Returns how many were removed.
 */
export async function removeOrphanedAutoSources(
  trx: Kysely<Database>,
  clock: Clock,
  sourceIds: readonly string[],
): Promise<number> {
  if (sourceIds.length === 0) {
    return 0;
  }
  const orphans = await trx
    .selectFrom("sources")
    .select(["id", "plugin", "label", "kind"])
    .where("id", "in", sourceIds)
    .where("auto_created", "=", 1)
    .where("kind", "=", "tracking")
    // Sign-in data is the stored secret. The session store is not: keyless plug-ins keep run
    // state there (cookies, rate budgets) on every run, so it says nothing about the user.
    .where("secret_blob", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("parcel_sources")
            .select("parcel_sources.parcel_id")
            .whereRef("parcel_sources.source_id", "=", "sources.id"),
        ),
      ),
    )
    .execute();
  for (const orphan of orphans) {
    await trx.deleteFrom("sources").where("id", "=", orphan.id).execute();
    await appendSourceRemoved(trx, clock, orphan, null);
  }
  return orphans.length;
}

/** Associated data for a source's encrypted blobs: a blob copied to another row fails to decrypt. */
export const secretAad = (sourceId: string): string => `source:${sourceId}:secret`;
export const sessionAad = (sourceId: string): string => `source:${sourceId}:session`;

export interface SourceView {
  readonly id: string;
  readonly plugin: string;
  readonly kind: SourceKind;
  readonly label: string;
  readonly config: unknown;
  readonly hasSecret: boolean;
  readonly state: SourceState;
  readonly stateDetail: string | null;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastOkAt: string | null;
}

export interface NewSource {
  readonly plugin: string;
  readonly kind: SourceKind;
  readonly label: string;
  readonly config: unknown;
  readonly secret: unknown;
}

function toView(row: SourceRow): SourceView {
  return {
    id: row.id,
    plugin: row.plugin,
    kind: row.kind,
    label: row.label,
    config: JSON.parse(row.config) as unknown,
    hasSecret: row.secret_blob !== null,
    state: row.state,
    stateDetail: row.state_detail,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastOkAt: row.last_ok_at,
  };
}

/** Creating, configuring and inspecting sources. Secrets never leave this class unencrypted. */
export class SourceService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly registry: PluginRegistry,
    private readonly secrets: SecretBox,
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  async list(): Promise<SourceView[]> {
    const rows = await this.db.selectFrom("sources").selectAll().orderBy("created_at").execute();
    return rows.map(toView);
  }

  async get(id: string): Promise<SourceView | undefined> {
    const row = await this.db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? undefined : toView(row);
  }

  async create(input: NewSource): Promise<SourceView> {
    const config = this.#validate(input);
    const id = crypto.randomUUID();
    const now = isoNow(this.clock);
    await this.db
      .insertInto("sources")
      .values({
        id,
        plugin: input.plugin,
        kind: input.kind,
        label: input.label,
        config: JSON.stringify(config),
        secret_blob:
          input.secret === null ? null : this.secrets.encryptJson(input.secret, secretAad(id)),
        session_blob: null,
        // Nothing has judged the source yet; its first run (due at once) decides, and a run that
        // finds no stored sign-in says "not signed in yet", never "rejected".
        state: "ok",
        state_detail: input.kind === "mail" ? null : NOT_RUN_YET,
        // Mailboxes are driven by the mail watcher (IMAP IDLE), never by the poll scheduler.
        next_run_at: input.kind === "mail" ? null : now,
        created_at: now,
        updated_at: now,
      })
      .execute();
    const created = await this.get(id);
    if (created === undefined) {
      throw new Error("Created source could not be read back.");
    }
    return created;
  }

  /** Validates a new source and returns its configuration with defaults applied. */
  #validate(input: NewSource): unknown {
    if (input.kind === "mail" || input.plugin === MAIL_PLUGIN) {
      if (input.kind !== "mail" || input.plugin !== MAIL_PLUGIN) {
        throw new InvalidSourceConfigError(
          `Mailboxes use the plug-in "${MAIL_PLUGIN}" and the kind "mail".`,
        );
      }
      const config = mailConfigSchema.safeParse(input.config);
      const secret = mailSecretSchema.safeParse(input.secret);
      if (!config.success || !secret.success) {
        throw new InvalidSourceConfigError("The mailbox needs a host, a username and a password.");
      }
      return config.data;
    }
    const plugin = this.registry.get(input.plugin);
    if (plugin === undefined) {
      throw new InvalidSourceConfigError(`There is no carrier plug-in called ${input.plugin}.`);
    }
    if (!plugin.info.sourceKinds.includes(input.kind)) {
      throw new InvalidSourceConfigError(`${plugin.info.name} has no ${input.kind} source.`);
    }
    plugin.validateConfig(input.config);
    return input.config;
  }

  /**
   * The tracking source of a plug-in, created on first use. Codes the user adds by hand, and codes
   * handed over by shops, are tracked through it.
   */
  async ensureTrackingSource(pluginId: string): Promise<string> {
    const id = await trackingSourceIn(this.db, this.registry, this.clock)(pluginId);
    if (id === undefined) {
      throw new InvalidSourceConfigError(`There is no carrier plug-in that tracks ${pluginId}.`);
    }
    return id;
  }

  /** Links active parcels no carrier source follows to their tracking source; see `linking.ts`. */
  async linkUntracked(options: LinkOptions = {}): Promise<LinkResult> {
    return linkUntrackedParcels(
      this.db,
      this.clock,
      trackingSourceIn(this.db, this.registry, this.clock),
      options,
    );
  }

  /**
   * Checks sign-in data against the source's plug-in before it is stored, so a malformed secret
   * is refused at once instead of failing every later run. Throws InvalidSourceConfigError.
   */
  async checkSecret(id: string, secret: unknown): Promise<void> {
    const row = await this.db
      .selectFrom("sources")
      .select(["plugin", "kind"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      return;
    }
    if (row.kind === "mail") {
      if (!mailSecretSchema.safeParse(secret).success) {
        throw new InvalidSourceConfigError("The mailbox needs a username and a password.");
      }
      return;
    }
    const plugin = this.registry.get(row.plugin);
    if (plugin !== undefined && !plugin.info.secretSchema.safeParse(secret).success) {
      throw new InvalidSourceConfigError(`The sign-in data does not fit ${plugin.info.name}.`);
    }
  }

  async setSecret(id: string, secret: unknown): Promise<void> {
    await this.db
      .updateTable("sources")
      .set({
        secret_blob: this.secrets.encryptJson(secret, secretAad(id)),
        session_blob: null,
        updated_at: isoNow(this.clock),
      })
      .where("id", "=", id)
      .execute();
    await this.setState(id, "ok", null);
    await this.requestRun(id);
  }

  async updateSettings(
    id: string,
    changes: { label?: string; config?: unknown; enabled?: boolean },
  ): Promise<SourceView | undefined> {
    const row = await this.db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    if (changes.config !== undefined) {
      this.registry.get(row.plugin)?.validateConfig(changes.config);
    }
    await this.db
      .updateTable("sources")
      .set({
        ...(changes.label === undefined ? {} : { label: changes.label }),
        ...(changes.config === undefined ? {} : { config: JSON.stringify(changes.config) }),
        updated_at: isoNow(this.clock),
      })
      .where("id", "=", id)
      .execute();
    if (changes.enabled === false) {
      await this.setState(id, "disabled", null);
    } else if (changes.enabled === true && row.state === "disabled") {
      await this.#enable(row);
    }
    return this.get(id);
  }

  /**
   * Re-enables a disabled source without claiming more than is known: one that never ran
   * successfully says "not run yet" instead of a bare OK. It is due at once, so a run decides
   * (and a run without any stored sign-in reports "not signed in yet").
   */
  async #enable(row: SourceRow): Promise<void> {
    const proven = row.last_ok_at !== null || row.kind === "mail";
    await this.setState(row.id, "ok", proven ? null : NOT_RUN_YET);
    if (row.kind !== "mail") {
      await this.requestRun(row.id);
    }
  }

  /** Deletes the source and fires `source.removed`, so clients drop its device at once. */
  async delete(id: string): Promise<boolean> {
    const deleted = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("sources")
        .select(["id", "plugin", "label", "kind"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (row === undefined) {
        return false;
      }
      await trx.deleteFrom("sources").where("id", "=", id).execute();
      await appendSourceRemoved(trx, this.clock, row, null);
      return true;
    });
    if (deleted) {
      await this.bus.notify();
    }
    return deleted;
  }

  /** Fires `source.run_finished`: a run ended, whatever its outcome. */
  async announceRun(
    source: { id: string; plugin: string; label: string; kind: SourceKind },
    ok: boolean,
  ): Promise<void> {
    await appendEvent(this.db, this.clock, {
      type: "source.run_finished",
      parcelId: null,
      payload: {
        source: { id: source.id, plugin: source.plugin, label: source.label, kind: source.kind },
        ok,
      },
    });
    await this.bus.notify();
  }

  /**
   * Asks the scheduler to run this source as soon as possible, but never before its backoff ends:
   * a captcha pause or a carrier's 429 is honoured whoever asks. Returns the time the run was
   * deferred to, or null when it is due now.
   */
  async requestRun(id: string): Promise<{ deferredUntil: string | null }> {
    const row = await this.db
      .selectFrom("sources")
      .select("backoff_until")
      .where("id", "=", id)
      .executeTakeFirst();
    const now = this.clock.now().getTime();
    const until = row?.backoff_until ?? null;
    const backoff = until === null ? Number.NaN : Date.parse(until);
    const deferredUntil =
      Number.isFinite(backoff) && backoff > now ? new Date(backoff).toISOString() : null;
    await this.db
      .updateTable("sources")
      .set({ next_run_at: deferredUntil ?? isoNow(this.clock) })
      .where("id", "=", id)
      .execute();
    return { deferredUntil };
  }

  /** Changes the state and fires `source.state_changed` when it actually changed. */
  async setState(id: string, state: SourceState, detail: string | null): Promise<void> {
    const row = await this.db
      .selectFrom("sources")
      .select(["state", "plugin", "label"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      return;
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("sources")
        .set({ state, state_detail: detail, updated_at: isoNow(this.clock) })
        .where("id", "=", id)
        .execute();
      if (row.state !== state) {
        await appendEvent(trx, this.clock, {
          type: "source.state_changed",
          parcelId: null,
          payload: {
            source: { id, plugin: row.plugin, label: row.label },
            old_state: row.state,
            new_state: state,
            detail,
          },
        });
      }
    });
    await this.bus.notify();
  }
}
