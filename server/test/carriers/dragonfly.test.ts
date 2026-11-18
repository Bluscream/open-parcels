import { describe, expect, it } from "vitest";
import { dragonfly } from "../../src/carriers/dragonfly/index.js";
import { register } from "../../src/engine/registry.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { harness, scripted } from "./kit-harness.js";

// Made-up codes and values only.
const CODE = "DFTEST0000001";
const NL = `GET dragonflyshipping.nl/cfworker/v3/tracking/${CODE}/`;
const plugin = register(dragonfly);

function status(step: number, timestamp: string, nl: string) {
  return { step, timestamp, labels: { shortLabel: { nl, en: "English text" } } };
}

function result(step: number, extra: Record<string, unknown> = {}) {
  return {
    tracking_id: CODE,
    client_code: "EXAMPLESHOP",
    last_status: {
      ...status(step, "2026-11-18T09:00:00Z", "Bij de bezorger in [link x]{city}[/link]"),
      package_location: { address: { city: "Voorbeeldstad" } },
    },
    public_eta: { from: "2026-11-18T13:00:00Z", to: "2026-11-18T15:00:00Z" },
    status_list: [
      status(1, "2026-11-17T08:00:00Z", "Aangemeld"),
      status(2, "2026-11-17T20:00:00Z", "In het sorteercentrum"),
    ],
    ...extra,
  };
}

describe("Dragonfly tracking", () => {
  it("maps the step, fills the label and reads the window", async () => {
    const { fetchImpl } = scripted({
      [NL]: [{ status: 200, body: { success: true, data: { result: result(3) } } }],
    });
    const { base, unknown } = harness(dragonfly.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(found).toMatchObject({
      carrier: "dragonfly",
      status: "out_for_delivery",
      rawStatus: "Bij de bezorger in Voorbeeldstad",
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:00:00.000Z",
      sender: "EXAMPLESHOP",
      url: `https://dragonflyshipping.nl/nl/volg-je-pakket/?tracking-id=${CODE}`,
    });
    expect(found?.history.map((event) => [event.status, event.rawStatus])).toEqual([
      ["in_transit", "In het sorteercentrum"],
      ["registered", "Aangemeld"],
    ]);
    expect(unknown).toEqual([]);
  });

  it("uses the chosen country's host and treats a buffered window as its end", async () => {
    const route = `GET intelcom.ca/cfworker/v3/tracking/${CODE}/`;
    const parcel = result(4, { public_eta: {}, last_status: { step: 4, isDelivered: true } });
    const { fetchImpl } = scripted({
      [route]: [{ status: 200, body: { success: true, data: { result: parcel } } }],
    });
    const { base } = harness(dragonfly.http, fetchImpl);
    const [found] = (await plugin.track(base, { country: "CA" }, null, [CODE])).snapshots;
    expect(found).toMatchObject({ status: "delivered", delivered: true, plannedFrom: null });
  });

  it("treats the not_found envelope as not found", async () => {
    const { fetchImpl } = scripted({
      [NL]: [{ status: 200, body: { success: false, data: { code: "not_found" } } }],
    });
    const { base } = harness(dragonfly.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown step and stops on an unknown envelope", async () => {
    const { fetchImpl } = scripted({
      [NL]: [
        { status: 200, body: { success: true, data: { result: result(9) } } },
        { status: 200, body: { success: false, data: { code: "rate" } } },
      ],
    });
    const { base, unknown } = harness(dragonfly.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(found?.status).toBeNull();
    expect(unknown).toEqual(["status:step:9"]);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });
});
