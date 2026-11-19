import { describe, expect, it } from "vitest";
import { flag, pickOne } from "./urlState";

describe("address parameters", () => {
  it("matches allowed values regardless of case and falls back otherwise", () => {
    const views = ["active", "delivered", "all"] as const;
    expect(pickOne("Delivered", views, "active")).toBe("delivered");
    expect(pickOne(" ALL ", views, "active")).toBe("all");
    expect(pickOne("shipped", views, "active")).toBe("active");
    expect(pickOne(null, views, "active")).toBe("active");
  });

  it("reads switches as on only for clear yes values", () => {
    expect(["1", "true", "Yes", "on"].map(flag)).toEqual([true, true, true, true]);
    expect(["0", "false", "", "maybe"].map(flag)).toEqual([false, false, false, false]);
    expect(flag(null)).toBe(false);
  });
});
