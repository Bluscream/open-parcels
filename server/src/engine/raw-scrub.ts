import type { Kysely } from "kysely";
import type { Database } from "../db/schema.js";
import { SECRET_KEYS } from "../log/redact.js";

/**
 * Keys never kept in stored raw payloads, compared lower-case without `_` and `-`: codes that open
 * or sign in to something, and personal data (who signed, names, addresses, contact details,
 * coordinates). Raw payloads are for diagnosing a carrier's answer, which none of these help with.
 */
const DROPPED_KEYS: ReadonlySet<string> = new Set(
  [
    ...SECRET_KEYS,
    "pickupCode",
    "unlockCode",
    "collectionCode",
    "pinCode",
    "shipmentPin",
    "otp",
    "verificationCode",
    "openCode",
    "signedBy",
    "signatory",
    "signature",
    "signerName",
    "receivedBy",
    "recipient",
    "recipientName",
    "recipientAddress",
    "receiver",
    "receiverName",
    "receiverAddress",
    "consignee",
    "consigneeName",
    "addressee",
    "shipTo",
    "deliveryAddress",
    "address",
    "addressLine",
    "addressLine1",
    "addressLine2",
    "street",
    "streetName",
    "houseNumber",
    "phone",
    "phoneNumber",
    "mobile",
    "email",
    "emailAddress",
    "firstName",
    "lastName",
    "fullName",
    "personName",
    "contactName",
    "contact",
    "latitude",
    "longitude",
    "lat",
    "lng",
    "lon",
    "coordinates",
    "geo",
  ].map(normaliseKey),
);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

const MAX_DEPTH = 12;

/** A deep copy of a raw payload without the dropped keys, wherever they are nested. */
export function scrubRaw(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubRaw(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!DROPPED_KEYS.has(normaliseKey(key))) {
        result[key] = scrubRaw(inner, depth + 1);
      }
    }
    return result;
  }
  return value;
}

/** Scrubs raw payloads stored by older versions. Idempotent; returns how many rows changed. */
export async function scrubStoredRaw(db: Kysely<Database>): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("parcel_raw")
      .select(["parcel_id", "source_id", "payload"])
      .execute();
    let changed = 0;
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const payload = JSON.stringify(scrubRaw(parsed));
      if (payload !== row.payload) {
        await trx
          .updateTable("parcel_raw")
          .set({ payload })
          .where("parcel_id", "=", row.parcel_id)
          .where("source_id", "=", row.source_id)
          .execute();
        changed += 1;
      }
    }
    return changed;
  });
}
