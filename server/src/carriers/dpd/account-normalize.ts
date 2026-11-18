import { snapshot, type ParcelSnapshot, type SnapshotEvent } from "../../plugin/api.js";
import type { Detail, Row, Slot, Tab } from "./account-page.js";
import {
  iconStatus,
  KNOWN_ICON_PAIRS,
  KNOWN_SLOT_TEXTS,
  mapDpd,
  publicUrl,
  textStatus,
  type ParcelStatus,
} from "./status.js";
import { dayInSentence, inferYears, localIso, type Day } from "./time.js";

/** One list row with its detail panel: fresh, or the last one read when this poll had none. */
export interface AccountParcel {
  readonly tab: Tab;
  readonly row: Row;
  readonly detail: Detail | null;
  readonly staleDetail: Detail | null;
}

export type UnknownReporter = (kind: string, key: string) => void;

const isDated = (slot: Slot): boolean => slot.date !== "" && slot.date !== "-";
const isReached = (slot: Slot): boolean => slot.text !== "" && slot.text !== "-";

function slotStatus(slot: Slot): ParcelStatus | null {
  return mapDpd({ code: slot.slot })?.status ?? null;
}

function isReturn(sentence: string, slots: readonly Slot[]): boolean {
  return (
    textStatus(sentence) === "returning" ||
    slots.some((slot) => isReached(slot) && textStatus(slot.text) === "returning")
  );
}

/**
 * The status of one account parcel. The order matters: a return delivered back to the sender
 * fills the last milestone and its sentence says "Geliefert", so returns are decided first; the
 * dated milestones decide next; the icon never overrides a dated milestone.
 */
export function accountStatus(
  sentence: string,
  icon: number | null,
  slots: readonly Slot[] | null,
): ParcelStatus | null {
  const all = slots ?? [];
  if (isReturn(sentence, all)) {
    return "returning";
  }
  const furthest = all.filter(isDated).at(-1);
  const delivered =
    furthest === undefined ? iconStatus(icon) === "delivered" : furthest.slot === "Delivered";
  const sentenceStatus = textStatus(sentence);
  const pickupWording =
    sentenceStatus === "at_pickup_point" ||
    (furthest !== undefined && textStatus(furthest.text) === "at_pickup_point");
  if (!delivered && pickupWording) {
    return "at_pickup_point";
  }
  if (furthest !== undefined) {
    return slotStatus(furthest);
  }
  return sentenceStatus ?? iconStatus(icon);
}

function history(slots: readonly Slot[], days: readonly (Day | null)[], returning: boolean) {
  const events: SnapshotEvent[] = [];
  slots.forEach((slot, index) => {
    const day = days[index];
    if (day === null || day === undefined) {
      return;
    }
    events.push({
      at: localIso(day),
      // On a return every milestone is part of the way back; none may read as a delivery.
      status: returning ? "returning" : slotStatus(slot),
      rawStatus: slot.text,
      location: null,
    });
  });
  return events;
}

function weightKg(text: string): number | null {
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) {
    return null;
  }
  const value = Number(text.replace(",", "."));
  return value > 0 ? value : null;
}

/** Reports, once each through the core, wordings and codes no parcel has shown yet. */
function collectUnknowns(
  parcel: AccountParcel,
  status: ParcelStatus | null,
  report: UnknownReporter,
): void {
  for (const slot of parcel.detail?.slots ?? []) {
    if (isReached(slot) && !KNOWN_SLOT_TEXTS.has(slot.text.toLowerCase())) {
      report("milestone_text", `${slot.slot}:${slot.text}`);
    }
  }
  const flowType = parcel.detail?.flowType ?? "";
  if (flowType !== "" && flowType !== "0") {
    report("flow_type", flowType);
  }
  const { icon, sentence } = parcel.row;
  if (icon !== null && !KNOWN_ICON_PAIRS.has(`${icon}:${status ?? "null"}`)) {
    report("status_icon", `${icon}:${status ?? "null"}`);
  }
  if (status === null) {
    // Day numbers vary per parcel; strip them so one wording is reported once.
    report("status_text", sentence.replace(/\d{1,2}\.\d{1,2}\.(\d{4})?/g, "").trim());
  }
}

/** One account parcel as a snapshot. Sender and receiver stay null: the page names neither. */
export function accountSnapshot(
  parcel: AccountParcel,
  today: Day,
  report: UnknownReporter,
): ParcelSnapshot {
  const { row, detail, tab } = parcel;
  const slots = detail?.slots ?? null;
  const historySlots = slots ?? parcel.staleDetail?.slots ?? [];
  const days = inferYears(
    historySlots.map((slot) => slot.date),
    today,
  );
  const status = accountStatus(row.sentence, row.icon, slots);
  collectUnknowns(parcel, status, report);
  const dayOf = (name: Slot["slot"]): Day | null =>
    days[historySlots.findIndex((slot) => slot.slot === name)] ?? null;
  const delivered = status === "delivered";
  const deliveredDay = delivered
    ? (dayOf("Delivered") ?? dayInSentence(row.sentence, today))
    : null;
  const loadedDay = status === "out_for_delivery" ? dayOf("CarLoad") : null;
  return snapshot({
    carrier: "dpd",
    barcode: row.barcode,
    direction: tab === "incoming" ? "incoming" : "outgoing",
    status,
    rawStatus: row.sentence === "" ? null : row.sentence,
    delivered,
    deliveredAt: deliveredDay === null ? null : localIso(deliveredDay),
    plannedFrom: loadedDay === null ? null : localIso(loadedDay),
    plannedTo: loadedDay === null ? null : localIso(loadedDay, 23, 59, 59),
    pickup: status === "at_pickup_point",
    url: publicUrl(row.barcode),
    weightKg: weightKg(detail?.weightText ?? ""),
    history: history(historySlots, days, isReturn(row.sentence, historySlots)),
    raw: {
      tab,
      statusSentence: row.sentence,
      statusIcon: row.icon,
      detailIcon: detail?.icon ?? null,
      slots,
      weightText: detail?.weightText ?? "",
      flowType: detail?.flowType ?? "",
    },
  });
}
