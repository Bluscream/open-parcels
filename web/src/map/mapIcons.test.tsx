import { describe, expect, it } from "vitest";
import { determineTransportMethod } from "./mapIcons";

const at = (raw_status: string, timestamp = "2030-01-01T00:00:00Z") => ({ raw_status, timestamp });

describe("determineTransportMethod", () => {
  it.each([
    ["Sorted for onward transport", "unknown"],
    ["Shipment data received", "unknown"],
    ["Sendung wurde zugestellt", "unknown"],
    ["Out for delivery", "van"],
    ["Loaded onto the aircraft", "plane"],
    ["Sendung per Luftfracht unterwegs", "plane"],
    ["Departed on the vessel", "ship"],
    ["In transit", "truck"],
  ])("reads %s as %s", (text, method) => {
    expect(determineTransportMethod([at(text)])).toBe(method);
  });

  it("uses the newest entry that says anything", () => {
    expect(
      determineTransportMethod([
        at("Out for delivery", "2030-01-02T00:00:00Z"),
        at("Shipment data received", "2030-01-03T00:00:00Z"),
        at("Loaded onto the aircraft", "2030-01-01T00:00:00Z"),
      ]),
    ).toBe("van");
  });
});
