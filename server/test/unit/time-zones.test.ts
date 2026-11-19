import { describe, expect, it } from "vitest";
import { isoTime } from "../../src/plugin/api.js";

/* Carrier times without an offset are read in the carrier's own zone, never the server's. */

describe("a carrier time without an offset", () => {
  it("is local time in the zone the carrier names", () => {
    const options = { naive: { zone: "Europe/Zurich" } } as const;
    expect(isoTime("2026-11-18T10:00:00", options)).toBe("2026-11-18T09:00:00.000Z");
    expect(isoTime("2026-07-18T10:00:00", options)).toBe("2026-07-18T08:00:00.000Z");
    // A bare date is that local day's midnight.
    expect(isoTime("2026-11-18", options)).toBe("2026-11-17T23:00:00.000Z");
  });

  it("still reads textual forms that name their zone, and nothing else", () => {
    const options = { naive: { zone: "Europe/Paris" } } as const;
    expect(isoTime("Wed, 18 Nov 2026 10:00:00 GMT", options)).toBe("2026-11-18T10:00:00.000Z");
    expect(isoTime("Wed, 18 Nov 2026 10:00:00 +0100", options)).toBe("2026-11-18T09:00:00.000Z");
    expect(isoTime("18 Nov 2026 10:00", options)).toBeNull();
  });
});
