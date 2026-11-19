import { describe, expect, it } from "vitest";
import { boundsAround, distanceKm, formatDistance, formatLatLng, parseLatLng } from "./geo";

describe("parseLatLng", () => {
  it.each([
    ["52.520008, 13.404954", [52.520008, 13.404954]],
    ["52.520008 13.404954", [52.520008, 13.404954]],
    ["52.520008;13.404954", [52.520008, 13.404954]],
    ["-33.8688,151.2093", [-33.8688, 151.2093]],
    ["52,520008 13,404954", [52.520008, 13.404954]],
    ["  48 11 ", [48, 11]],
  ])("reads %s", (text, expected) => {
    expect(parseLatLng(text)).toEqual(expected);
  });

  it.each(["Example Street 1, Berlin", "95, 10", "10, 200", "52.5", ""])(
    "leaves %s to the place search",
    (text) => {
      expect(parseLatLng(text)).toBeNull();
    },
  );
});

describe("boundsAround", () => {
  it("mirrors every point around the centre, so fitting them keeps the centre in the middle", () => {
    const points = boundsAround([50, 8], [[52, 13]]);
    expect(points).toEqual([
      [50, 8],
      [52, 13],
      [48, 3],
    ]);
    const lats = points.map(([lat]) => lat);
    const lngs = points.map(([, lng]) => lng);
    expect((Math.min(...lats) + Math.max(...lats)) / 2).toBe(50);
    expect((Math.min(...lngs) + Math.max(...lngs)) / 2).toBe(8);
  });

  it("is just the centre without points", () => {
    expect(boundsAround([50, 8], [])).toEqual([[50, 8]]);
  });
});

describe("distances", () => {
  it("measures great-circle distance", () => {
    // Two made-up points one degree of latitude apart: about 111 km.
    expect(distanceKm([50, 8], [51, 8])).toBeCloseTo(111.2, 0);
    expect(distanceKm([50, 8], [50, 8])).toBe(0);
  });

  it("formats metres below a kilometre and fewer decimals further out", () => {
    expect(formatDistance(0.347, "en")).toBe("350 m");
    expect(formatDistance(4.24, "en")).toBe("4.2 km");
    expect(formatDistance(106.4, "en")).toBe("106 km");
    expect(formatDistance(1234.4, "en")).toBe("1,234 km");
  });

  it("writes coordinates back with six decimals", () => {
    expect(formatLatLng([52.5, 13.4])).toBe("52.500000, 13.400000");
  });
});
