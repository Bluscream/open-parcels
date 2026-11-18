import { describe, expect, it } from "vitest";
import { paack } from "../../src/carriers/paack/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, inOrder, raw, type Answer } from "./harness.js";

// Made-up codes and values only.
const CODE = "TEST000000001";
const POSTCODE = "00000";
const plugin = register(paack);
const config = { postalCode: POSTCODE };

function page(label: string, extra: Record<string, unknown> = {}): string {
  const order = {
    orderTrackData: {
      external_id: CODE,
      retailer_name: "Example Shop",
      expected_delivery_ts: { start: "2026-11-18T09:00:00Z", end: "2026-11-18T13:00:00Z" },
    },
    activeEvent: { label, timestamp: "2026-11-18T07:00:00Z" },
    eventList: [
      { label: "created", timestamp: "2026-11-16T10:00:00Z" },
      { label: "receivedAtHub", timestamp: "2026-11-17T10:00:00Z" },
      { label, timestamp: "2026-11-18T07:00:00Z" },
    ],
    ...extra,
  };
  const context = { state: { loaderData: { "routes/tracking.order": order } } };
  return `<html><script>window.__remixContext = ${JSON.stringify(context)};</script></html>`;
}

const html = (body: string) => raw(body, 200, { "content-type": "text/html" });
const JSON_TYPE = { "content-type": "application/json" };
/** Replies in order; once they run out, 404 with an empty body. */
const scripted = (replies: Answer[]) =>
  fakeNetwork([inOrder(...replies)], () => raw("", 404, JSON_TYPE));

describe("Paack public tracking", () => {
  it("reads status, window and history from the embedded route data", async () => {
    const { fetchImpl, calls } = scripted([html(page("inDelivery"))]);
    const { base } = fakeContext(paack.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "paack",
      barcode: CODE,
      status: "out_for_delivery",
      delivered: false,
      plannedFrom: "2026-11-18T09:00:00.000Z",
      plannedTo: "2026-11-18T13:00:00.000Z",
      sender: "Example Shop",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(calls[0]?.url.searchParams.get("postal_code")).toBe(POSTCODE);
  });

  it("treats a redirect, a 404 and an error page as not found", async () => {
    const { fetchImpl } = scripted([
      raw("", 302, { ...JSON_TYPE, location: "/error" }),
      raw("", 404, JSON_TYPE),
      html("<html>Order not found</html>"),
    ]);
    const { base } = fakeContext(paack.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE, CODE, CODE]);
    expect(result.snapshots).toEqual([]);
  });

  it("skips codes without a postcode", async () => {
    const { fetchImpl, calls } = scripted([]);
    const { base } = fakeContext(paack.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reports an unknown label and leaves the status null", async () => {
    const { fetchImpl } = scripted([html(page("somethingNew"))]);
    const { base, reports: unknown } = fakeContext(paack.http, fetchImpl);
    const [parcel] = (await plugin.track(base, config, null, [CODE])).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual([{ kind: "status_code", key: "somethingNew" }]);
  });

  it("fails transiently on network errors and stops on a page without route data", async () => {
    const network = scripted([new Error("offline")]);
    await expect(
      plugin.track(fakeContext(paack.http, network.fetchImpl).base, config, null, [CODE]),
    ).rejects.toBeInstanceOf(TransientError);
    const odd = scripted([html("<html>maintenance</html>")]);
    await expect(
      plugin.track(fakeContext(paack.http, odd.fetchImpl).base, config, null, [CODE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
