import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normaliseBarcode } from "../../src/engine/barcode.js";
import { repairBarcodes } from "../../src/engine/barcode-repair.js";
import { trackEach } from "../../src/plugin/api.js";
import { FakeWorld, fakePost, scan, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* One spelling per code. Every code here is made up. */

const UPS_TYPED = "1z 000 0a0 0000000001";
const UPS_CODE = "1Z0000A00000000001";

describe("the stored spelling of a code", () => {
  it("drops spaces and upper-cases a code the carrier's pattern accepts", () => {
    expect(normaliseBarcode("ups", UPS_TYPED)).toBe(UPS_CODE);
    expect(normaliseBarcode("gls", " 0000 0000 001 ")).toBe("00000000001");
  });

  it("keeps opaque tokens and texts the pattern rejects as given, trimmed", () => {
    expect(normaliseBarcode("budbee", " AbCdEf123 ")).toBe("AbCdEf123");
    expect(normaliseBarcode("ups", "order #12")).toBe("order #12");
  });
});

describe("a lookup's answer", () => {
  it("is filed under the code as tracked, the carrier's own number kept as a reference", async () => {
    const result = await trackEach(["TRACKED0001"], /^\w+$/, () =>
      Promise.resolve(
        snapshot({ carrier: "x", barcode: "CARRIER-ID-9", status: null, rawStatus: null }),
      ),
    );
    expect(result.snapshots[0]).toMatchObject({
      barcode: "TRACKED0001",
      externalRef: "CARRIER-ID-9",
    });
  });
});

describe("codes in another spelling", () => {
  let context: TestContext;
  let post: FakeWorld;

  beforeEach(async () => {
    post = new FakeWorld();
    context = await createTestContext({ plugins: [fakePost(post)] });
  });
  afterEach(async () => {
    await context.close();
  });

  it("are one parcel: typed by hand with spaces, echoed compact by the carrier", async () => {
    const typed = await context.services.parcels.create({
      carrier: "ups",
      barcode: UPS_TYPED,
      direction: "incoming",
      label: null,
    });
    expect(typed.barcode).toBe(UPS_CODE);
    post.listing = [
      snapshot({
        carrier: "ups",
        barcode: UPS_CODE.toLowerCase(),
        status: "in_transit",
        rawStatus: "On the way",
      }),
    ];
    const source = await context.services.sources.create({
      plugin: "fakepost",
      kind: "account",
      label: "account",
      config: {},
      secret: { username: "user@example.invalid", password: ["p", "q"].join("-") },
    });
    await context.services.runner.run(source.id);
    const rows = await context.services.db.selectFrom("parcels").select(["id", "status"]).execute();
    expect(rows).toEqual([{ id: typed.id, status: "in_transit" }]);
  });

  it("stored twice by an older version are merged at startup into the oldest", async () => {
    const db = context.services.db;
    const insert = async (id: string, barcode: string, firstSeen: string, label: string | null) => {
      await db
        .insertInto("parcels")
        .values({
          id,
          carrier: "ups",
          barcode,
          direction: "incoming",
          status: "in_transit",
          raw_status: null,
          delivered: 0,
          pickup: 0,
          label,
          first_seen_at: firstSeen,
          last_seen_at: firstSeen,
          updated_at: firstSeen,
        })
        .execute();
      const event = scan(firstSeen, `Scan ${id.slice(-1)}`, "in_transit");
      await db
        .insertInto("parcel_events")
        .values({
          parcel_id: id,
          source_id: null,
          at: event.at,
          status: event.status,
          raw_status: event.rawStatus,
          location_text: null,
          fingerprint: `fp-${id}`,
        })
        .execute();
    };
    const older = "00000000-0000-4000-8000-0000000000a1";
    const newer = "00000000-0000-4000-8000-0000000000a2";
    await insert(older, UPS_TYPED, "2026-11-01T00:00:00.000Z", null);
    await insert(newer, UPS_CODE, "2026-11-02T00:00:00.000Z", "Kettle");

    expect(await repairBarcodes(db, context.clock)).toEqual({ respelled: 1, folded: 1 });
    expect(await repairBarcodes(db, context.clock)).toEqual({ respelled: 0, folded: 0 });

    const parcels = await db.selectFrom("parcels").select(["id", "barcode", "label"]).execute();
    expect(parcels).toEqual([{ id: older, barcode: UPS_CODE, label: "Kettle" }]);
    const events = await db.selectFrom("parcel_events").select("parcel_id").execute();
    expect(events.map((row) => row.parcel_id)).toEqual([older, older]);
    const deleted = await db
      .selectFrom("outbox")
      .select(["type", "parcel_id"])
      .where("type", "=", "parcel.deleted")
      .execute();
    expect(deleted).toEqual([{ type: "parcel.deleted", parcel_id: newer }]);
  });
});
