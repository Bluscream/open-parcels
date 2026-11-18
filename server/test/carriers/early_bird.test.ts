import { describe, expect, it } from "vitest";
import { earlyBird } from "../../src/carriers/early_bird/index.js";
import { register } from "../../src/engine/registry.js";
import { CaptchaError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, json, raw, routeTable } from "./harness.js";

// Made-up codes and values only.
const CODE = "EBTEST000001";
const ROUTE = "POST earlybird.se/api/tracking";
const plugin = register(earlyBird);

const event = (text: string, occurredAt: string) => ({ text, occurredAt });

function timeline(...events: { text: string; occurredAt: string }[]) {
  return { type: "timeline", trackingNumber: CODE, status: events[0], events };
}

describe("Early Bird tracking", () => {
  it("classifies the newest sentence, skips neutral ones and reads local times", async () => {
    const { fetchImpl, calls } = fakeNetwork([
      routeTable(
        {
          [ROUTE]: [
            json(
              timeline(
                event("We have scheduled a new attempt for tomorrow.", "2026-11-18T07:00:00"),
                event(
                  "Your package is now ready for collection from the parcel locker at X.",
                  "2026-11-17T18:00:00",
                ),
                event("Early Bird has received your package.", "2026-11-17T06:00:00"),
              ),
              200,
            ),
          ],
        },
        "host",
      ),
    ]);
    const { base, unknown } = fakeContext(earlyBird.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ trackingNumber: CODE, locale: "en" });
    expect(found).toMatchObject({
      carrier: "early_bird",
      status: "at_pickup_point",
      pickup: true,
      rawStatus: "We have scheduled a new attempt for tomorrow.",
      plannedFrom: null,
    });
    expect(found?.history.map((entry) => [entry.at, entry.status])).toEqual([
      ["2026-11-18T06:00:00.000Z", null],
      ["2026-11-17T17:00:00.000Z", "at_pickup_point"],
      ["2026-11-17T05:00:00.000Z", "in_transit"],
    ]);
    expect(unknown).toEqual([]);
  });

  it("dates a delivery from the delivering event", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [ROUTE]: [
            json(timeline(event("The package has been delivered.", "2026-11-18T05:30:00")), 200),
          ],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(earlyBird.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(found).toMatchObject({ status: "delivered", deliveredAt: "2026-11-18T04:30:00.000Z" });
  });

  it("treats tracking_not_found as not found", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [ROUTE]: [json({ code: "tracking_not_found" }, 404)],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(earlyBird.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown sentence", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [ROUTE]: [json(timeline(event("Something new happened.", "2026-11-18T05:30:00")), 200)],
        },
        "host",
      ),
    ]);
    const { base, unknown } = fakeContext(earlyBird.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(found?.status).toBeNull();
    expect(unknown).toEqual(["status_text:Something new happened."]);
  });

  it("pauses on a browser challenge instead of retrying", async () => {
    const { fetchImpl } = fakeNetwork([
      routeTable(
        {
          [ROUTE]: [
            raw("<html></html>", 403, {
              "content-type": "application/json",
              "x-vercel-mitigated": "challenge",
            }),
          ],
        },
        "host",
      ),
    ]);
    const { base } = fakeContext(earlyBird.http, fetchImpl);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(CaptchaError);
  });
});
