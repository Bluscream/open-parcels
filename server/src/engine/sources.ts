import type { Kysely } from "kysely";
import { isoNow, type Clock } from "../clock.js";
import type { SecretBox } from "../crypto/secrets.js";
import type { Database, SourceRow } from "../db/schema.js";
import { appendEvent, type EventBus } from "../events/bus.js";
import { InvalidSourceConfigError, type PluginRegistry } from "./registry.js";

export type SourceKind = SourceRow["kind"];
export type SourceState = SourceRow["state"];

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
    const plugin = this.registry.get(input.plugin);
    if (plugin === undefined) {
      throw new InvalidSourceConfigError(`There is no carrier plug-in called ${input.plugin}.`);
    }
    if (input.kind !== "mail" && !plugin.info.sourceKinds.includes(input.kind)) {
      throw new InvalidSourceConfigError(`${plugin.info.name} has no ${input.kind} source.`);
    }
    plugin.validateConfig(input.config);
    const id = crypto.randomUUID();
    const now = isoNow(this.clock);
    await this.db
      .insertInto("sources")
      .values({
        id,
        plugin: input.plugin,
        kind: input.kind,
        label: input.label,
        config: JSON.stringify(input.config),
        secret_blob:
          input.secret === null ? null : this.secrets.encryptJson(input.secret, secretAad(id)),
        session_blob: null,
        state: "ok",
        state_detail: null,
        next_run_at: now,
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

  /**
   * The tracking source of a plug-in, created on first use. Codes the user adds by hand, and codes
   * handed over by shops, are tracked through it.
   */
  async ensureTrackingSource(pluginId: string): Promise<string> {
    const existing = await this.db
      .selectFrom("sources")
      .select("id")
      .where("plugin", "=", pluginId)
      .where("kind", "=", "tracking")
      .orderBy("created_at")
      .executeTakeFirst();
    if (existing !== undefined) {
      return existing.id;
    }
    const plugin = this.registry.get(pluginId);
    const created = await this.create({
      plugin: pluginId,
      kind: "tracking",
      label: `${plugin?.info.name ?? pluginId} tracking`,
      config: {},
      secret: null,
    });
    return created.id;
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
    if (changes.enabled !== undefined) {
      await this.setState(id, changes.enabled ? "ok" : "disabled", null);
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("sources").where("id", "=", id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }

  /** Asks the scheduler to run this source as soon as possible. */
  async requestRun(id: string): Promise<void> {
    await this.db
      .updateTable("sources")
      .set({ next_run_at: isoNow(this.clock) })
      .where("id", "=", id)
      .execute();
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
