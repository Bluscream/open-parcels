import { describe, expect, it } from "vitest";
import type { Parcel } from "../api/types";
import { statsBySource } from "./SourcesPage";

function parcel(sources: string[], delivered: boolean, archived = false): Parcel {
  return {
    sources: sources.map((source_id) => ({ source_id })),
    delivered,
    archived_at: archived ? "2026-01-01T00:00:00Z" : null,
  } as unknown as Parcel;
}

describe("parcels per source", () => {
  it("counts each parcel once per source: on the way, delivered and all", () => {
    const stats = statsBySource([
      parcel(["a", "a"], false),
      parcel(["a", "b"], true),
      parcel(["b"], false, true),
    ]);
    expect(stats.get("a")).toEqual({ active: 1, delivered: 1, total: 2 });
    expect(stats.get("b")).toEqual({ active: 0, delivered: 1, total: 2 });
    expect(stats.get("c")).toBeUndefined();
  });
});
