import { loadRules } from "open-parcels-rules";
import { describe, expect, it } from "vitest";
import { createMailInterpreter } from "../../src/mail/interpret.js";

const interpret = createMailInterpreter(loadRules(), "Europe/Berlin");

describe("mail interpretation with the shared rules", () => {
  it("turns a German DHL shipping notice into a DHL parcel", () => {
    const snapshots = interpret({
      messageId: null,
      from: "DHL Paket <noreply@dhl.de>",
      subject: "Ihr DHL Paket kommt heute",
      text: "Guten Tag, Ihre Sendung 00340434000000000017 wird heute zugestellt.",
      html: null,
      date: new Date("2026-11-18T07:00:00Z"),
    });
    expect(snapshots.map((s) => [s.carrier, s.barcode])).toEqual([["dhl", "00340434000000000017"]]);
  });

  it("ignores mails without a tracking number", () => {
    expect(
      interpret({
        messageId: null,
        from: "news@shop.example.invalid",
        subject: "Sale!",
        text: "Everything 20% off.",
        html: null,
        date: null,
      }),
    ).toEqual([]);
  });
});
