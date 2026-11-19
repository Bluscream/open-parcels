import { loadRules } from "open-parcels-rules";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healState, mergeParcel, type ParcelState } from "../../src/engine/merge.js";
import { maskIdentifiers } from "../../src/engine/vocab.js";
import { createMailInterpreter } from "../../src/mail/interpret.js";
import type { MailInput } from "../../src/mail/types.js";
import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../src/plugin/snapshot.js";
import { createTestContext, type TestContext } from "../helpers.js";

// A made-up version of a Hermes parcel seen live: the carrier says delivered, and a few seconds
// later its delivery mail arrives twice with wording the old rules did not map.
const BARCODE = "H1000012000000109999";
const OUT_FOR_DELIVERY: SnapshotEvent = {
  at: "2026-11-18T07:30:00.000Z",
  status: "out_for_delivery",
  rawStatus: "Die Sendung wurde ins Zustellfahrzeug geladen.",
  location: null,
};
const CARRIER_DELIVERED: SnapshotEvent = {
  at: "2026-11-18T14:28:12.000Z",
  status: "delivered",
  rawStatus: "Die Sendung wurde an der Empfangsadresse zugestellt.",
  location: null,
};
const SUBJECT = "Erfolgreiche Haustürzustellung";

function hermesSnapshot(): ParcelSnapshot {
  return snapshot({
    carrier: "hermes",
    barcode: BARCODE,
    status: "delivered",
    rawStatus: "DELIVERED_HOMEDELIVERY",
    delivered: true,
    history: [OUT_FOR_DELIVERY, CARRIER_DELIVERED],
  });
}

function mailEntry(at: string, id?: string): SnapshotEvent {
  return {
    at,
    status: null,
    rawStatus: SUBJECT,
    location: null,
    ...(id === undefined ? {} : { id }),
  };
}

/** The delivery mail as the old rules read it: no status at all. */
function statuslessMail(at: string, id?: string): ParcelSnapshot {
  return snapshot({
    carrier: "hermes",
    barcode: BARCODE,
    status: null,
    rawStatus: SUBJECT,
    history: [mailEntry(at, id)],
  });
}

function mail(date: string): MailInput {
  return {
    messageId: "<made-up-1@example.invalid>",
    from: "Hermes <noreply@paketankuendigung.myhermes.de>",
    subject: SUBJECT,
    text: `Ihre Sendung ${BARCODE} haben wir heute an Ihrer Haustür übergeben.`,
    html: null,
    date: new Date(date),
  };
}

describe("merging a statusless mail into a delivered parcel", () => {
  it("never lets the mail override the carrier's mapped status", () => {
    const delivered = mergeParcel(null, hermesSnapshot(), "carrier");
    expect(delivered).toMatchObject({ status: "delivered", delivered: true });
    expect(delivered.deliveredAt).not.toBeNull();

    const after = mergeParcel(delivered, statuslessMail("2026-11-18T14:28:16.000Z"), "secondary", [
      OUT_FOR_DELIVERY,
      CARRIER_DELIVERED,
    ]);
    expect(after).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: delivered.deliveredAt,
      rawStatus: "DELIVERED_HOMEDELIVERY",
    });
  });

  it("falls back to the newest mapped entry of the merged history", () => {
    const stored: ParcelState = {
      ...mergeParcel(null, statuslessMail("2026-11-18T14:28:15.000Z"), "secondary"),
    };
    expect(stored.status).toBe("unknown");
    const after = mergeParcel(stored, statuslessMail("2026-11-18T14:28:16.000Z"), "secondary", [
      OUT_FOR_DELIVERY,
      CARRIER_DELIVERED,
    ]);
    expect(after).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: CARRIER_DELIVERED.at,
      rawStatus: CARRIER_DELIVERED.rawStatus,
    });
  });

  it("treats a carrier's delivered flag as delivered even without a mapped code", () => {
    const flagged = snapshot({
      ...hermesSnapshot(),
      status: null,
      rawStatus: "SOME_NEW_CODE",
      delivered: true,
      history: [],
    });
    expect(mergeParcel(null, flagged, "carrier")).toMatchObject({
      status: "delivered",
      delivered: true,
    });
  });

  it("repairs a parcel stored the old way, once", () => {
    const broken: ParcelState = {
      ...mergeParcel(null, statuslessMail("2026-11-18T14:28:16.000Z"), "secondary"),
      rawStatus: SUBJECT,
    };
    const history = [OUT_FOR_DELIVERY, CARRIER_DELIVERED, mailEntry("2026-11-18T14:28:16.000Z")];
    const healed = healState(broken, history);
    expect(healed).toMatchObject({ status: "delivered", delivered: true });
    expect(healed?.deliveredAt).toBe(CARRIER_DELIVERED.at);
    expect(healed === null ? "unhealed" : healState(healed, history)).toBeNull();
  });
});

describe("the Hermes delivery mail", () => {
  const interpret = createMailInterpreter(loadRules(), "Europe/Berlin");

  it("maps to delivered through the rules", () => {
    const [found] = interpret(mail("2026-11-18T14:28:16Z"));
    expect(found).toMatchObject({ carrier: "hermes", status: "delivered", delivered: true });
    expect(found?.history[0]?.status).toBe("delivered");
  });

  it("gives the same entry id when the mail is read twice", () => {
    const first = interpret(mail("2026-11-18T14:28:15Z"))[0]?.history[0]?.id;
    const second = interpret(mail("2026-11-18T14:28:16Z"))[0]?.history[0]?.id;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });
});

describe("masking identifiers in recorded mail subjects", () => {
  it("keeps the wording and drops numbers", () => {
    expect(maskIdentifiers(`Ihre Sendung ${BARCODE} kommt`)).toBe("Ihre Sendung # kommt");
    expect(maskIdentifiers(SUBJECT)).toBe(SUBJECT);
  });
});

describe("the reconciler with a carrier and a mail source", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await createTestContext();
  });
  afterEach(async () => {
    await context.close();
  });

  async function addSource(id: string, kind: "tracking" | "mail"): Promise<void> {
    const now = "2026-11-18T00:00:00.000Z";
    await context.services.db
      .insertInto("sources")
      .values({
        id,
        plugin: kind === "mail" ? "imap" : "hermes",
        kind,
        label: id,
        config: "{}",
        secret_blob: null,
        session_blob: null,
        state: "ok",
        state_detail: null,
        backoff_until: null,
        next_run_at: null,
        last_run_at: null,
        last_ok_at: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }

  async function parcelRow() {
    return context.services.db
      .selectFrom("parcels")
      .selectAll()
      .where("barcode", "=", BARCODE)
      .executeTakeFirstOrThrow();
  }

  it("keeps the parcel delivered, stores one entry per mail and records unmapped wording", async () => {
    await addSource("carrier", "tracking");
    await addSource("mailbox", "mail");
    const { reconciler, db } = context.services;
    await reconciler.ingest("carrier", { snapshots: [hermesSnapshot()], complete: false });
    const duplicate = (at: string): ParcelSnapshot =>
      statuslessMail(at, "mail:<made-up-1@example.invalid>");
    await reconciler.ingest("mailbox", {
      snapshots: [duplicate("2026-11-18T14:28:15.000Z"), duplicate("2026-11-18T14:28:16.000Z")],
      complete: false,
    });

    const row = await parcelRow();
    expect(row).toMatchObject({ status: "delivered", delivered: 1 });
    expect(row.delivered_at).not.toBeNull();
    const events = await db
      .selectFrom("parcel_events")
      .select("raw_status")
      .where("parcel_id", "=", row.id)
      .execute();
    expect(events.filter((event) => event.raw_status === SUBJECT)).toHaveLength(1);
    const vocab = await db.selectFrom("unknown_vocab").selectAll().execute();
    expect(vocab).toMatchObject([{ plugin: "hermes", kind: "mail_subject", key: SUBJECT }]);
  });

  it("repairs a parcel already stored as unknown, idempotently", async () => {
    await addSource("carrier", "tracking");
    await addSource("mailbox", "mail");
    const { reconciler, db } = context.services;
    await reconciler.ingest("carrier", { snapshots: [hermesSnapshot()], complete: false });
    const stored = await parcelRow();
    // Put the parcel back the way the old merge left it.
    await db
      .updateTable("parcels")
      .set({ status: "unknown", raw_status: SUBJECT, delivered: 0, delivered_at: null })
      .where("id", "=", stored.id)
      .execute();

    expect(await reconciler.repair()).toBe(1);
    const healed = await parcelRow();
    expect(healed).toMatchObject({
      status: "delivered",
      delivered: 1,
      delivered_at: CARRIER_DELIVERED.at,
    });
    expect(await reconciler.repair()).toBe(0);
  });

  it("heals an unknown parcel on its next reconcile", async () => {
    await addSource("carrier", "tracking");
    await addSource("mailbox", "mail");
    const { reconciler, db } = context.services;
    await reconciler.ingest("carrier", { snapshots: [hermesSnapshot()], complete: false });
    const stored = await parcelRow();
    await db
      .updateTable("parcels")
      .set({ status: "unknown", delivered: 0, delivered_at: null })
      .where("id", "=", stored.id)
      .execute();
    await reconciler.ingest("mailbox", {
      snapshots: [statuslessMail("2026-11-18T14:28:20.000Z")],
      complete: false,
    });
    expect(await parcelRow()).toMatchObject({ status: "delivered", delivered: 1 });
  });
});
