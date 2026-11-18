import { describe, expect, it } from "vitest";
import { colisprive } from "../../src/carriers/colisprive/index.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { html, on, World } from "./kit-harness.js";

// Made-up codes and values only.
const CODE = "TESTCP0000001";
const config = { postalCode: "00000", language: "en" as const };

function page(status: string, rows: [string, string][]) {
  return `<html><body><div id="ctl00_CDC_pnResultatColis">
    <h1><span>Example Shop</span></h1>
    <div class="divDesti"><div><p>Test Person</p><p>1 Example Street</p></div></div>
    <div class="divStatut"><table><tr><td class="tdText">${status}</td></tr></table></div>
    <table><tr><th id="th-date">Date</th><th id="th-statut">Status</th></tr>
    ${rows
      .map(
        ([date, text]) =>
          `<tr class="bandeauText"><td headers="th-date">${date}</td><td headers="th-statut">${text}</td></tr>`,
      )
      .join("\n")}
    </table></div></body></html>`;
}

describe("Colis Privé tracking", () => {
  it("reads status, the delivery day and history without the recipient block", async () => {
    const world = new World(colisprive);
    world.routes = [
      on(
        "detailColis.aspx",
        html(
          page("Your parcel is being delivered by the driver", [
            ["18/11/2026", "Your parcel is being delivered by the driver"],
            ["17/11/2026", "Your parcel has arrived at our regional distribution office"],
            ["16/11/2026", "Your parcel was prepared by your webmerchant"],
          ]),
        ),
      ),
    ];
    const [parcel] = (await world.track([CODE], config, null)).snapshots;
    expect(world.calls[0]?.url.searchParams.get("numColis")).toBe(`${CODE}00000`);
    expect(parcel).toMatchObject({
      carrier: "colisprive",
      status: "out_for_delivery",
      sender: "Example Shop",
      plannedFrom: "2026-11-17T23:00:00.000Z",
      plannedTo: "2026-11-18T22:59:59.000Z",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(JSON.stringify(parcel?.raw)).not.toContain("Test Person");
  });

  it("treats a redirect to the start page as not found", async () => {
    const world = new World(colisprive);
    world.routes = [
      on(
        "detailColis.aspx",
        new Response(null, { status: 302, headers: { location: "/moncolis/Default.aspx" } }),
      ),
    ];
    expect((await world.track([CODE], config, null)).snapshots).toEqual([]);
  });

  it("reports an unknown sentence and falls back to the furthest stage", async () => {
    const world = new World(colisprive);
    world.routes = [
      on(
        "detailColis.aspx",
        html(
          page("Something new", [["17/11/2026", "Your parcel was prepared by your webmerchant"]]),
        ),
      ),
    ];
    const [parcel] = (await world.track([CODE], config, null)).snapshots;
    expect(parcel?.status).toBe("registered");
    expect(world.unknown).toEqual(["status_code:en:something new"]);
  });

  it("stops on a page it does not recognise", async () => {
    const world = new World(colisprive);
    world.routes = [on("detailColis.aspx", html("<html>maintenance</html>"))];
    await expect(world.track([CODE], config, null)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
