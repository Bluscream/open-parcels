import { describe, expect, it } from "vitest";
import { helthjem } from "../../src/carriers/helthjem/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { keylessContext, scripted, type Reply } from "./keyless-harness.js";

// Made-up codes and values only.
const CODE = "TEST00000001";
const plugin = register(helthjem);

function parcel(status: string, extra: Record<string, unknown> = {}): Reply {
  return {
    status: 200,
    body: {
      data: {
        getParcelTrackingDetails: {
          trackingNumber: CODE,
          status,
          estimatedDelivery: { date: "2026-04-10" },
          servicePoint: { name: "Test Point", address: "Test Street 1" },
          deliveryPoint: { type: "MAILBOX" },
          events: [
            { createdAt: "2026-04-08T08:00:00Z", status: "REGISTERED", message: null },
            {
              createdAt: "2026-04-09T08:00:00Z",
              status,
              location: "Test Terminal",
              message: { description: "Latest step" },
            },
          ],
          ...extra,
        },
      },
    },
  };
}

async function run(replies: Reply[]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknown } = keylessContext(helthjem.http, fetchImpl);
  const result = await plugin.track(base, {}, null, [CODE]);
  return { result, calls, unknown };
}

describe("helthjem", () => {
  it("reads status, estimate, pickup point and history", async () => {
    const { result, calls } = await run([parcel("READY_FOR_PICKUP")]);
    expect(calls[0]?.headers.get("origin")).toBe("https://helthjem.no");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toMatchObject({ variables: { ref: CODE } });
    const [snap] = result.snapshots;
    expect(snap?.status).toBe("at_pickup_point");
    expect(snap?.pickup).toBe(true);
    expect(snap?.pickupPoint).toBe("Test Point");
    expect(snap?.plannedFrom).toBe("2026-04-10T00:00:00.000Z");
    expect(snap?.plannedTo).toBeNull();
    expect(snap?.history[0]).toEqual({
      at: "2026-04-09T08:00:00.000Z",
      rawStatus: "Latest step",
      status: "at_pickup_point",
      location: "Test Terminal",
    });
    expect(snap?.history[1]?.rawStatus).toBe("REGISTERED");
  });

  it("takes the delivery time from the delivered event", async () => {
    const { result } = await run([parcel("DELIVERED")]);
    expect(result.snapshots[0]?.deliveredAt).toBe("2026-04-09T08:00:00.000Z");
    expect(result.snapshots[0]?.plannedFrom).toBeNull();
  });

  it("returns nothing for an unknown reference", async () => {
    const { result } = await run([
      { status: 200, body: { data: { getParcelTrackingDetails: null } } },
    ]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports an unmapped status once", async () => {
    const { result, unknown } = await run([parcel("SOMETHING_NEW")]);
    expect(unknown).toEqual(["SOMETHING_NEW"]);
    expect(result.snapshots[0]?.status).toBeNull();
  });

  it("stops on GraphQL errors, HTTP errors and network errors", async () => {
    await expect(
      run([{ status: 200, body: { errors: [{ message: "bad" }], data: null } }]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(run([{ status: 200, text: "<html>" }])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(run([{ status: 500, text: "" }])).rejects.toBeInstanceOf(TransientError);
    await expect(run([new Error("offline")])).rejects.toBeInstanceOf(TransientError);
  });
});
