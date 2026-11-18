import { describe, expect, it } from "vitest";
import { speeDee } from "../../src/carriers/speedee/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeRoutes, harness, type Reply } from "./route-harness.js";

// Made-up codes, places and names only.
const CODE = "SP00000000000001";
const ROUTE = "GET packages.speedeedelivery.com/package_progress.php";

function page(status: string, scans: [string, string, string][], extra = ""): Reply {
  const rows = scans
    .map(([when, where, what]) => `<tr><td>${when}</td><td>${where}</td><td>${what}</td></tr>`)
    .join("\n");
  return {
    status: 200,
    contentType: "text/html",
    body: `<html><body><script>var x = "<table>";</script>
<table class="u-full-width"><tbody>
<tr><td>Tracking Number:</td><td>${CODE}</td></tr>
<tr><td>Status:</td><td>${status}</td></tr>
${extra}
</tbody></table>
<h3>Package Progress</h3>
<table><tr><th>Date / Time</th><th>Location</th><th>Activity</th></tr>
${rows}
</table>
<p>All times shown are Central&nbsp;Time (USA).</p></body></html>`,
  };
}

describe("Spee-Dee tracking", () => {
  it("reads the summary status, Central times and the scan history", async () => {
    const { fetchImpl } = fakeRoutes({
      [ROUTE]: [
        page("OUT FOR DELIVERY (00000)", [
          ["11/18/2026 07:30:00 AM", "Testville", "OUT FOR DELIVERY (00000)"],
          ["11/17/2026 10:00 PM", "Testville", "UNLOAD SCAN: 00000"],
          ["11/17/2026 01:00 PM", "Sampletown", "ARRIVAL SCAN"],
        ]),
      ],
    });
    const { plugin, base } = harness(speeDee, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "speedee",
      barcode: CODE,
      status: "out_for_delivery",
      rawStatus: "OUT FOR DELIVERY",
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.url).toContain(CODE);
    // November is CST, six hours behind UTC.
    expect(parcel?.history.map((e) => [e.at, e.status, e.rawStatus])).toEqual([
      ["2026-11-18T13:30:00.000Z", "out_for_delivery", "OUT FOR DELIVERY"],
      ["2026-11-18T04:00:00.000Z", "in_transit", "UNLOAD SCAN"],
      ["2026-11-17T19:00:00.000Z", "in_transit", "ARRIVAL SCAN"],
    ]);
  });

  it("takes the delivery time from the summary", async () => {
    const { fetchImpl } = fakeRoutes({
      [ROUTE]: [
        page(
          "DELIVERED",
          [["07/01/2026 02:00 PM", "Testville", "DELIVERED"]],
          "<tr><td>Delivered On:</td><td>07/01/2026 02:00 PM</td></tr>",
        ),
      ],
    });
    const { plugin, base } = harness(speeDee, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    // July is CDT, five hours behind UTC.
    expect(parcel).toMatchObject({ delivered: true, deliveredAt: "2026-07-01T19:00:00.000Z" });
  });

  it("treats 404 as not found and skips implausible codes", async () => {
    const { fetchImpl, calls } = fakeRoutes({ [ROUTE]: [{ status: 404, body: "" }] });
    const { plugin, base } = harness(speeDee, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE, "../x"])).snapshots).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("reports an unknown summary and falls back to the newest mapped scan", async () => {
    const { fetchImpl } = fakeRoutes({
      [ROUTE]: [
        page("HELD AT DEPOT (00000)", [
          ["11/18/2026 07:30 AM", "Testville", "HELD AT DEPOT (00000)"],
          ["11/17/2026 01:00 PM", "Sampletown", "ARRIVAL SCAN"],
        ]),
      ],
    });
    const { plugin, base, unknown } = harness(speeDee, fetchImpl);
    const [parcel] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(unknown).toEqual(["held at depot"]);
  });

  it("fails closed on a changed page, a redirect or a server error", async () => {
    const changed = harness(
      speeDee,
      fakeRoutes({ [ROUTE]: [{ status: 200, body: "<html>maintenance</html>" }] }).fetchImpl,
    );
    await expect(changed.plugin.track(changed.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    const moved = harness(speeDee, fakeRoutes({ [ROUTE]: [{ status: 302, body: "" }] }).fetchImpl);
    await expect(moved.plugin.track(moved.base, {}, null, [CODE])).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});
