import { describe, expect, it } from "vitest";
import { gobolt } from "../../src/carriers/gobolt/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, inOrder, json, raw, type Answer } from "./harness.js";

/** Replies in order; once they run out, 500 with an empty body. */
const scripted = (replies: Answer[]) => fakeNetwork([inOrder(...replies)], () => raw("", 500));

// Made-up codes and values only.
const CODE = "ZZTEST000001";
const plugin = register(gobolt);

function parcel(label_status: string, extra: Record<string, unknown> = {}): Answer {
  return json(
    {
      tracking_number: CODE,
      label_status,
      estimated_delivery_date: "2026-03-05T00:00:00Z",
      transit_steps: [
        { name: label_status, created_at: "2026-03-04T15:00:00Z", description: "Test place" },
        { name: "label_scanned", created_at: "2026-03-03T10:00:00Z" },
        { name: "label_created", created_at: "2026-03-02T09:00:00Z" },
      ],
      ...extra,
    },
    200,
  );
}

async function run(replies: Answer[]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknownKeys: unknown } = fakeContext(gobolt.http, fetchImpl);
  const result = await plugin.track(base, {}, null, [CODE]);
  return { result, calls, unknown };
}

describe("gobolt", () => {
  it("reads status, estimate and history", async () => {
    const { result, calls } = await run([parcel("label_out_for_delivery")]);
    expect(calls[0]?.url.searchParams.get("tracking_number")).toBe(CODE);
    const [snap] = result.snapshots;
    expect(snap?.status).toBe("out_for_delivery");
    expect(snap?.plannedFrom).toBe("2026-03-05T00:00:00.000Z");
    expect(snap?.plannedTo).toBeNull();
    expect(snap?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(snap?.history[0]?.location).toBeNull();
  });

  it("marks a delivery and clears the estimate", async () => {
    const { result } = await run([
      parcel("label_delivered", { label_delivered_at: "2026-03-04T16:00:00Z" }),
    ]);
    expect(result.snapshots[0]?.delivered).toBe(true);
    expect(result.snapshots[0]?.deliveredAt).toBe("2026-03-04T16:00:00.000Z");
    expect(result.snapshots[0]?.plannedFrom).toBeNull();
  });

  it("returns nothing for an unknown code", async () => {
    const { result } = await run([json({ message: "Tracking number not found" }, 404)]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports an unmapped status and falls back to the newest mapped step", async () => {
    const { result, unknown } = await run([parcel("label_teleported")]);
    expect(unknown).toEqual(["label_teleported"]);
    expect(result.snapshots[0]?.status).toBe("in_transit");
  });

  it("stops on unexpected answers and network errors", async () => {
    await expect(run([json({ message: "nope" }, 404)])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(run([json({}, 200)])).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(run([raw("", 500)])).rejects.toBeInstanceOf(TransientError);
    await expect(run([new Error("offline")])).rejects.toBeInstanceOf(TransientError);
  });
});
