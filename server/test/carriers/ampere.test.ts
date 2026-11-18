import { describe, expect, it } from "vitest";
import { ampere } from "../../src/carriers/ampere/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { html, json, on, World, type Route } from "./harness.js";

// Made-up links, codes and names only.
const LINK = "https://link.bol.com/t/mailtoken-1?notificationId=0";
const secret = { trackingLinks: [LINK] };
const HOST = "bol.prd.amperebezorgt.nl";
const BARCODE = "3STEST000000001";

function redirect(location: string, cookie?: string): Response {
  const headers = new Headers({ location });
  if (cookie !== undefined) {
    headers.append("set-cookie", `tnt_sessions=${cookie}; Path=/; Secure; HttpOnly`);
  }
  return new Response(null, { status: 302, headers });
}

/** The e-mail link: shop redirector → key page → parcel page, setting the session cookie. */
function exchangeRoutes(token: string, cookie: string): Route[] {
  return [
    on("GET link.bol.com/t/mailtoken-1", redirect(`https://${HOST}/nl/key/k-${token}`)),
    on(`GET ${HOST}/nl/key/k-${token}`, redirect(`/nl/parcel/${token}`, cookie)),
  ];
}

const row = (status: string, time: string) =>
  `<li><span data-test-id="history-entry-status">${status}</span>` +
  `<span data-test-id="history-entry-time">${time}</span></li>`;

function page(...rows: string[]): string {
  return [
    `<p data-test-id="status-text">Banner</p>`,
    `<span data-test-id="barcode-value">${BARCODE}</span>`,
    `<span data-test-id="company-name-value">Example Shop</span>`,
    `<span data-test-id="receiver-name">Test Person</span>`,
    `<ul>${rows.join("")}</ul>`,
  ].join("");
}

const progress = json({
  data: { deliveryWindow: { from: "2026-11-18T14:00:00+01:00", to: "2026-11-18T16:00:00+01:00" } },
});

describe("Ampère via e-mail tracking links", () => {
  it("follows the link once, reads the page and keeps the session", async () => {
    const w = new World(ampere);
    w.routes = [
      ...exchangeRoutes("p1", "c1"),
      on(
        `GET ${HOST}/nl/parcel/p1`,
        html(
          page(
            row("Bezorger is onderweg", "Wo 18 nov 09:15"),
            row("Pakket is gesorteerd", "Di 17 nov 21:16"),
          ),
        ),
      ),
      on(`GET ${HOST}/api/progress`, progress),
    ];
    const result = await w.fetchAccount({}, secret);
    expect(result.complete).toBe(true);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "ampere",
      barcode: BARCODE,
      status: "out_for_delivery",
      rawStatus: "Bezorger is onderweg",
      plannedFrom: "2026-11-18T13:00:00.000Z",
      plannedTo: "2026-11-18T15:00:00.000Z",
      sender: "Example Shop",
      url: null,
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T08:15:00.000Z", "out_for_delivery"],
      ["2026-11-17T20:16:00.000Z", "in_transit"],
    ]);
    expect(w.calls.find((c) => c.url.pathname === "/nl/parcel/p1")?.headers.get("cookie")).toBe(
      "tnt_sessions=c1",
    );
    expect(w.stored).toEqual({ [LINK]: { cookie: "c1", parcelToken: "p1" } });
    expect(JSON.stringify(parcel?.raw)).not.toContain("Test Person");
  });

  it("reuses a stored session and marks delivery", async () => {
    const w = new World(ampere);
    w.stored = { [LINK]: { cookie: "c1", parcelToken: "p1" } };
    w.routes = [
      on(`GET ${HOST}/nl/parcel/p1`, html(page(row("Pakket is bezorgd", "Wo 18 nov 12:00")))),
      on(`GET ${HOST}/api/progress`, json({}, 500)),
    ];
    const [parcel] = (await w.fetchAccount({}, secret)).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T11:00:00.000Z",
      plannedFrom: null,
    });
    expect(w.requests().some((r) => r.startsWith("GET link.bol.com"))).toBe(false);
  });

  it("follows the link again once when the stored session is refused", async () => {
    const w = new World(ampere);
    w.stored = { [LINK]: { cookie: "old", parcelToken: "p0" } };
    w.routes = [
      on(`GET ${HOST}/nl/parcel/p0`, html('<h1 data-test-id="error-title">Oeps</h1>')),
      ...exchangeRoutes("p2", "c2"),
      on(`GET ${HOST}/nl/parcel/p2`, html(page(row("Pakket is gesorteerd", "Di 17 nov 21:16")))),
      on(`GET ${HOST}/api/progress`, progress),
    ];
    const [parcel] = (await w.fetchAccount({}, secret)).snapshots;
    expect(parcel?.status).toBe("in_transit");
    expect(w.stored).toEqual({ [LINK]: { cookie: "c2", parcelToken: "p2" } });
  });

  it("reports page wording it does not know", async () => {
    const w = new World(ampere);
    w.stored = { [LINK]: { cookie: "c1", parcelToken: "p1" } };
    w.routes = [
      on(`GET ${HOST}/nl/parcel/p1`, html(page(row("Pakket is zoek", "Wo 18 nov 09:15")))),
      on(`GET ${HOST}/api/progress`, progress),
    ];
    const [parcel] = (await w.fetchAccount({}, secret)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["status_text:Pakket is zoek"]);
  });

  it("needs a new link when the only link is refused, but not on a network error", async () => {
    const refused = new World(ampere);
    refused.routes = [on("GET link.bol.com/t/mailtoken-1", html("gone", 410))];
    await expect(refused.fetchAccount({}, secret)).rejects.toBeInstanceOf(SignInRejectedError);

    const offline = new World(ampere);
    offline.stored = { [LINK]: { cookie: "c1", parcelToken: "p1" } };
    offline.routes = [on(`GET ${HOST}/nl/parcel/p1`, new Error("offline"))];
    await expect(offline.fetchAccount({}, secret)).rejects.toBeInstanceOf(TransientError);
    expect(offline.requests()).toEqual([`GET ${HOST}/nl/parcel/p1`]);
    expect(offline.stored).toEqual({ [LINK]: { cookie: "c1", parcelToken: "p1" } });
  });

  it("refuses to follow a link that leaves the shop and the tracker", async () => {
    const w = new World(ampere);
    await expect(
      w.fetchAccount({}, { trackingLinks: ["https://example.invalid/t/x"] }),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    expect(w.calls).toHaveLength(0);
  });
});
