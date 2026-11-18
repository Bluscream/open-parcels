import { describe, expect, it } from "vitest";
import { straightship } from "../../src/carriers/straightship/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, raw, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(straightship);

// Made-up codes, places and addresses only.
const CODE = "SSTEST0001";
const ROUTE = `GET straightship.com/track-your-shipment/tracking-id/${CODE}/`;

function page(status: string, rows: [string, string][], trackingId = CODE): Answer {
  const body = rows
    .map(([when, what]) => `<tr><td>${when}</td><td>${what}</td><td>Testville</td></tr>`)
    .join("");
  return raw(
    `<html><body>
<table><tr><th>Tracking ID</th><th>Package Status</th></tr>
<tr><td>${trackingId}</td><td>${status}</td></tr></table>
<table><tr><th>Timestamp</th><th>Status</th><th>City</th></tr>${body}</table>
<p>Last Updated: 2026-11-18 08:00:00</p></body></html>`,
    200,
  );
}

describe("Straightship tracking", () => {
  it("reads the summary, UTC times and the history without places", async () => {
    const { fetchImpl } = network({
      [ROUTE]: [
        page("Package will be delivered before 9:00pm (Testville, TX)", [
          ["2026-11-16 10:00:00", "Package information is created in the system"],
          ["2026-11-17 10:00:00", "Package is received at a Straightship station (Testville, TX)"],
          ["2026-11-18 08:00:00", "Package will be delivered before 9:00pm (Testville, TX)"],
        ]),
      ],
    });
    const { base } = fakeContext(straightship.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "straightship",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "Package will be delivered before 9:00pm",
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T08:00:00.000Z", "out_for_delivery"],
      ["2026-11-17T10:00:00.000Z", "in_transit"],
      ["2026-11-16T10:00:00.000Z", "registered"],
    ]);
  });

  it("redacts the contact address from a failed attempt", async () => {
    const attempt =
      "An attempt was made to deliver your package-unable to leave package at safe location (please e-mail someone@example.invalid to make arrangement)";
    const { fetchImpl } = network({
      [ROUTE]: [page(attempt, [["2026-11-18 08:00:00", attempt]])],
    });
    const { base } = fakeContext(straightship.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBe("problem");
    expect(JSON.stringify(parcel?.history)).not.toContain("example.invalid");
  });

  it("treats the no-results answer as not found", async () => {
    const { fetchImpl } = network({
      [ROUTE]: [raw("<p>No results found!</p>", 200)],
    });
    const { base } = fakeContext(straightship.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, "../x"])).snapshots).toEqual([]);
  });

  it("reports an unknown summary and falls back to the newest mapped event", async () => {
    const { fetchImpl } = network({
      [ROUTE]: [
        page("Held for inspection (Testville, TX)", [
          ["2026-11-17 10:00:00", "Loading"],
          ["2026-11-18 08:00:00", "Held for inspection (Testville, TX)"],
        ]),
      ],
    });
    const { base, unknownKeys: unknown } = fakeContext(straightship.http, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(unknown).toEqual(["Held for inspection"]);
  });

  it("stops on a changed page, a mismatched id or a server error", async () => {
    const changed = fakeContext(
      straightship.http,
      network({ [ROUTE]: [raw("<html>new</html>", 200)] }).fetchImpl,
    );
    await expect(plugin.track(changed.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    const other = fakeContext(
      straightship.http,
      network({ [ROUTE]: [page("Delivered", [], "SSTEST9999")] }).fetchImpl,
    );
    await expect(plugin.track(other.base, {}, null, [CODE])).rejects.toThrow(/different/);
    const failing = fakeContext(straightship.http, network({ [ROUTE]: [raw("", 503)] }).fetchImpl);
    await expect(plugin.track(failing.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});
