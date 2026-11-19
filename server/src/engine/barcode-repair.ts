import type { Kysely } from "kysely";
import type { Clock } from "../clock.js";
import type { Database, ParcelRow } from "../db/schema.js";
import { RAW_PRESENTATION, type Presentation } from "../parcels/repository.js";
import { normaliseBarcode } from "./barcode.js";
import { foldParcel } from "./fold.js";

export interface BarcodeRepair {
  /** Parcels whose code was rewritten in the carrier's spelling. */
  readonly respelled: number;
  /** Parcels folded into a twin that differed only in case or spaces. */
  readonly folded: number;
}

/**
 * Stores every code in its carrier's spelling (see `normaliseBarcode`). Codes that differed only
 * in case or spaces (`1z 999…` typed by hand, `1Z999…` echoed by the carrier) were two parcels;
 * they become one, kept under the oldest, with the others folded in. Idempotent.
 */
export async function repairBarcodes(
  db: Kysely<Database>,
  clock: Clock,
  presentation: Presentation = RAW_PRESENTATION,
): Promise<BarcodeRepair> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("parcels")
      .selectAll()
      .orderBy("first_seen_at")
      .orderBy("id")
      .execute();
    const groups = new Map<string, { spelling: string; rows: ParcelRow[] }>();
    for (const row of rows) {
      const spelling = normaliseBarcode(row.carrier, row.barcode);
      const key = JSON.stringify([row.carrier, spelling]);
      const group = groups.get(key) ?? { spelling, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    let respelled = 0;
    let folded = 0;
    for (const { spelling, rows: twins } of groups.values()) {
      const [keep, ...others] = twins;
      if (keep === undefined) {
        continue;
      }
      for (const other of others) {
        await foldParcel(trx, { clock, presentation }, other, keep);
        folded += 1;
      }
      // An active twin keeps the parcel active.
      const revive = keep.removed_at !== null && others.some((row) => row.removed_at === null);
      if (keep.barcode !== spelling || revive) {
        await trx
          .updateTable("parcels")
          .set({ barcode: spelling, ...(revive ? { removed_at: null } : {}) })
          .where("id", "=", keep.id)
          .execute();
        respelled += keep.barcode === spelling ? 0 : 1;
      }
    }
    return { respelled, folded };
  });
}
