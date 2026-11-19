import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import {
  isSettingKey,
  parseSetting,
  SETTING_KEYS,
  SETTINGS,
  toConfig,
  type AppConfig,
  type ApplyMode,
  type SettingKey,
  type SettingKind,
  type SettingValue,
  type SettingValues,
} from "../config.js";
import type { Database } from "../db/schema.js";

export type SettingSource = "env" | "default" | "override";

export interface SettingInfo {
  readonly key: SettingKey;
  readonly group: string;
  readonly description: string;
  readonly kind: SettingKind;
  readonly choices: readonly string[] | null;
  readonly apply: ApplyMode;
  readonly secret: boolean;
  readonly source: SettingSource;
  /** Whether a value is set at all; the only thing told about a secret. */
  readonly set: boolean;
  /** Null when unset, or for a secret. */
  readonly value: SettingValue | null;
  readonly default: SettingValue | null;
  /** A restart setting whose saved value differs from the one the server runs with. */
  readonly pendingRestart: boolean;
}

export type PatchResult =
  | { readonly ok: true; readonly changed: readonly SettingKey[] }
  | { readonly ok: false; readonly error: string };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isOwnForm = (key: SettingKey): boolean => "ownForm" in SETTINGS[key];
const shown = (value: unknown): string => (value === undefined ? "unset" : JSON.stringify(value));

/**
 * The OPENPARCELS_* settings: the environment with the values saved in the UI on top. A saved
 * value wins until it is reset. Live settings change `config` in place, so every reader sees the
 * new value at once; restart settings are saved now and used from the next start on.
 */
export class ConfigSettings {
  readonly #overrides = new Map<SettingKey, SettingValue>();
  /** Own-form settings whose UI value is kept elsewhere (the hashed admin password). */
  readonly #savedElsewhere = new Set<SettingKey>();
  /** What the server runs with; restart settings keep their start-up value here. */
  readonly #running: SettingValues;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** The shared config object; changed in place. */
    private readonly config: AppConfig,
    /** Called after a live setting changed, for what is not read from `config` on use. */
    private readonly onChange?: (key: SettingKey, config: AppConfig) => void,
  ) {
    this.#running = { ...config.env.values };
  }

  /** Reads the saved values and applies them all, restart ones included: this is a start. */
  async load(): Promise<void> {
    const rows = await this.db.selectFrom("setting_overrides").select(["key", "value"]).execute();
    for (const row of rows) {
      if (!isSettingKey(row.key) || SETTINGS[row.key].apply === "env") continue;
      const parsed = parseSetting(row.key, JSON.parse(row.value));
      if (parsed.ok && parsed.value !== undefined) {
        this.#overrides.set(row.key, parsed.value);
      } else {
        this.logger.warn(
          { key: row.key },
          "Ignoring a saved setting that is no longer valid; the environment or default applies.",
        );
      }
    }
    for (const key of SETTING_KEYS) this.#setRunning(key);
    this.#rebuild();
    for (const key of this.#overrides.keys()) this.onChange?.(key, this.config);
  }

  /** Records whether an own-form setting has a value saved in the UI, for `list`. */
  markSavedElsewhere(key: SettingKey, saved: boolean): void {
    if (saved) this.#savedElsewhere.add(key);
    else this.#savedElsewhere.delete(key);
  }

  list(): SettingInfo[] {
    return SETTING_KEYS.map((key) => this.#info(key));
  }

  /** Validates every entry first and saves nothing when one is invalid. */
  async patch(input: Readonly<Record<string, unknown>>): Promise<PatchResult> {
    const accepted: [SettingKey, SettingValue][] = [];
    for (const [key, raw] of Object.entries(input)) {
      if (!isSettingKey(key)) return { ok: false, error: `${key}: there is no such setting.` };
      if (isOwnForm(key)) return { ok: false, error: `${key}: change it with its own form.` };
      if (SETTINGS[key].apply === "env") {
        return {
          ok: false,
          error: `${key}: can only be set in the environment.`,
        };
      }
      const parsed = parseSetting(key, raw);
      if (!parsed.ok) return parsed;
      if (parsed.value === undefined) {
        return {
          ok: false,
          error: `${key}: a value is required. Reset the setting to go back to the environment or default.`,
        };
      }
      accepted.push([key, parsed.value]);
    }
    const now = isoNow(this.clock);
    await this.db.transaction().execute(async (trx) => {
      for (const [key, value] of accepted) {
        const json = JSON.stringify(value);
        await trx
          .insertInto("setting_overrides")
          .values({ key, value: json, updated_at: now })
          .onConflict((oc) => oc.column("key").doUpdateSet({ value: json, updated_at: now }))
          .execute();
      }
    });
    for (const [key, value] of accepted) {
      this.logger.info(
        { key, previous: shown(this.#configured(key)), value: shown(value) },
        "Setting changed in the UI.",
      );
      this.#overrides.set(key, value);
      this.#applyLive(key);
    }
    return { ok: true, changed: accepted.map(([key]) => key) };
  }

  /** Deletes the saved value, so the environment or default applies again. */
  async reset(key: string): Promise<PatchResult> {
    if (!isSettingKey(key)) return { ok: false, error: `${key}: there is no such setting.` };
    if (isOwnForm(key)) return { ok: false, error: `${key}: reset it with its own form.` };
    if (!this.#overrides.has(key)) return { ok: true, changed: [] };
    const previous = this.#overrides.get(key);
    await this.db.deleteFrom("setting_overrides").where("key", "=", key).execute();
    this.#overrides.delete(key);
    this.#applyLive(key);
    this.logger.info(
      { key, previous: shown(previous), value: shown(this.#configured(key)) },
      "Setting reset to the environment or default.",
    );
    return { ok: true, changed: [key] };
  }

  #configured(key: SettingKey): SettingValue | undefined {
    return this.#overrides.has(key) ? this.#overrides.get(key) : this.config.env.values[key];
  }

  #setRunning(key: SettingKey): void {
    // Every value came through the key's own schema.
    (this.#running as Record<SettingKey, SettingValue | undefined>)[key] = this.#configured(key);
  }

  #rebuild(): void {
    Object.assign(this.config, toConfig(this.#running, this.config.env));
  }

  #applyLive(key: SettingKey): void {
    if (SETTINGS[key].apply !== "live") return;
    this.#setRunning(key);
    this.#rebuild();
    this.onChange?.(key, this.config);
  }

  #info(key: SettingKey): SettingInfo {
    const def = SETTINGS[key];
    const secret = def.secret === true;
    const value = this.#configured(key);
    const fallback: SettingValue | undefined = def.default;
    const savedElsewhere = this.#savedElsewhere.has(key);
    const overridden = savedElsewhere || this.#overrides.has(key);
    return {
      key,
      group: def.group,
      description: def.description,
      kind: def.kind,
      choices: "choices" in def ? def.choices : null,
      apply: def.apply,
      secret,
      source: overridden ? "override" : this.config.env.sources[key],
      // An empty secret (an open reader password) is as good as unset.
      set: savedElsewhere || (value !== undefined && value !== ""),
      value: secret ? null : (value ?? null),
      default: secret ? null : (fallback ?? null),
      pendingRestart: def.apply === "restart" && !same(value, this.#running[key]),
    };
  }
}
