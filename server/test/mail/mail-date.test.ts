import { describe, expect, it } from "vitest";
import { mailDate, toMailInput } from "../../src/mail/watcher.js";

/* The time a mail stands for. Every address is made up. */

const NOW = new Date("2026-11-18T12:00:00Z");
const RECEIVED = new Date("2026-11-18T11:00:00Z");

function mail(dateHeader: string | null): Buffer {
  return Buffer.from(
    [
      "From: Shop <noreply@shop.example.invalid>",
      "To: someone@example.invalid",
      "Subject: Your parcel",
      ...(dateHeader === null ? [] : [`Date: ${dateHeader}`]),
      "",
      "On its way.",
    ].join("\r\n"),
  );
}

describe("a mail's time", () => {
  it("is its Date header when that is plausible", async () => {
    const input = await toMailInput(mail("Wed, 18 Nov 2026 10:00:00 +0000"), RECEIVED, NOW);
    expect(input.date?.toISOString()).toBe("2026-11-18T10:00:00.000Z");
  });

  it("is when the server received it when the header is missing", async () => {
    const input = await toMailInput(mail(null), RECEIVED, NOW);
    expect(input.date).toEqual(RECEIVED);
  });

  it("never lies in the future", async () => {
    const input = await toMailInput(mail("Fri, 18 Dec 2026 10:00:00 +0000"), RECEIVED, NOW);
    expect(input.date).toEqual(RECEIVED);
    expect(mailDate(new Date("2027-01-01T00:00:00Z"), null, NOW)).toBeNull();
    // A few minutes of clock skew is fine.
    const skewed = new Date(NOW.getTime() + 5 * 60_000);
    expect(mailDate(skewed, RECEIVED, NOW)).toEqual(skewed);
  });
});
