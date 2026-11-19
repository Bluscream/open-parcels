import type { Kysely } from "kysely";
import { z } from "zod";
import { isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { PARCEL_LABEL_MODES, type ParcelLabelMode } from "../domain/parcel.js";

export const homeSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    label: z.string().trim().max(300).nullable().default(null),
  })
  .describe("Where parcels go: centres the maps and gives distances. Set by the user.");
export type Home = z.infer<typeof homeSchema>;

const HOME = "home";
const PARCEL_LABEL = "parcel_label";
const labelSchema = z.enum(PARCEL_LABEL_MODES);

/**
 * The app's settings, kept in memory and written through to the `settings` table. Parcel reads
 * use the label mode on every row, so it must not cost a query.
 */
export class SettingsStore {
  #home: Home | null = null;
  #labelMode: ParcelLabelMode = "tracking_number";

  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
  ) {}

  async load(): Promise<void> {
    const rows = await this.db.selectFrom("settings").select(["key", "value"]).execute();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const read = <T>(key: string, schema: z.ZodType<T>): T | undefined => {
      const raw = values.get(key);
      if (raw === undefined) return undefined;
      const parsed = schema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    };
    this.#home = read(HOME, homeSchema) ?? null;
    this.#labelMode = read(PARCEL_LABEL, labelSchema) ?? "tracking_number";
  }

  get home(): Home | null {
    return this.#home;
  }

  get labelMode(): ParcelLabelMode {
    return this.#labelMode;
  }

  async setHome(home: Home | null): Promise<void> {
    await this.#write(HOME, home);
    this.#home = home;
  }

  async setLabelMode(mode: ParcelLabelMode): Promise<void> {
    await this.#write(PARCEL_LABEL, mode === "tracking_number" ? null : mode);
    this.#labelMode = mode;
  }

  async #write(key: string, value: unknown): Promise<void> {
    if (value === null) {
      await this.db.deleteFrom("settings").where("key", "=", key).execute();
      return;
    }
    const now = isoNow(this.clock);
    const json = JSON.stringify(value);
    await this.db
      .insertInto("settings")
      .values({ key, value: json, updated_at: now })
      .onConflict((oc) => oc.column("key").doUpdateSet({ value: json, updated_at: now }))
      .execute();
  }
}
