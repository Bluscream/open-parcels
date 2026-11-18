import { describe, expect, it } from "vitest";
import { hrvatskaPosta } from "../../src/carriers/hrvatska_posta/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, inOrder, raw, type Answer } from "./harness.js";

const JSON_TYPE = { "content-type": "application/json" };
/** Replies in order; once they run out, 404 with an empty body. */
const scripted = (replies: Answer[]) =>
  fakeNetwork([inOrder(...replies)], () => raw("", 404, JSON_TYPE));

// Made-up codes and values only.
const CODE = "ZZ000000001HR";
const plugin = register(hrvatskaPosta);

function row(date: string, wording: string, location: string): string {
  return (
    '<div class="d-none d-md-flex row">' +
    `<div class="col-lg-4"><span>${date}</span></div>` +
    `<div class="col-lg-8"><span class="x">${wording}</span><span>${location}</span></div>` +
    "</div>"
  );
}

function page(title: string, body: string): Answer {
  return raw(
    `<html><head><title>${title}</title><script>var a = "<div>";</script></head><body>${body}</body></html>`,
    200,
    { "content-type": "text/html" },
  );
}

function found(...rows: string[]): Answer {
  return page(
    "Hrvatska Pošta - Tracking",
    '<div class="track__n__trace"><div><span>Broj pošiljke</span><span>' +
      CODE +
      '</span><span>Masa</span><span>1250 g</span></div><img src="/img/logo.png">' +
      rows.join("") +
      "</div>",
  );
}

async function run(replies: Answer[]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknown } = fakeContext(hrvatskaPosta.http, fetchImpl);
  const result = await plugin.track(base, {}, null, [CODE]);
  return { result, calls, unknown };
}

describe("hrvatska_posta tracking", () => {
  it("reads a parcel waiting in a locker, with history and weight", async () => {
    const { result, calls, unknown } = await run([
      found(
        row("18.11.2026 09:15:00", "Pošiljka predana u paketomat", "10000 Paketomat Primjer"),
        row("17.11.2026 08:00:00", "Pošiljka preusmjerena u paketomat", "10000 Zagreb"),
        row("16.11.2026 10:00:00", "Pošiljka je otpremljena", "ZZABCD1 Example"),
        row("15.11.2026 12:00:00", "Pošiljka je zaprimljena", "10000 Zagreb"),
      ),
    ]);
    expect(calls[0]?.url.searchParams.get("barcode")).toBe(CODE);
    const parcel = result.snapshots[0];
    expect(parcel?.status).toBe("at_pickup_point");
    expect(parcel?.pickup).toBe(true);
    expect(parcel?.pickupPoint).toBe("Paketomat Primjer");
    expect(parcel?.weightKg).toBe(1.25);
    expect(parcel?.plannedFrom).toBeNull();
    expect(parcel?.plannedTo).toBeNull();
    // Zagreb is UTC+1 in November; the unknown "ZZ" office code falls back to Zagreb too.
    expect(parcel?.history.map((event) => [event.at, event.status])).toEqual([
      ["2026-11-18T08:15:00.000Z", "at_pickup_point"],
      ["2026-11-17T07:00:00.000Z", "in_transit"],
      ["2026-11-16T09:00:00.000Z", "in_transit"],
      ["2026-11-15T11:00:00.000Z", "registered"],
    ]);
    expect(unknown).toEqual([]);
  });

  it("treats a delivery after a return started as returning", async () => {
    const { result } = await run([
      found(
        row("18.11.2026 10:00:00", "Pošiljka je uručena", "10000 Zagreb"),
        row("17.11.2026 10:00:00", "Pošiljka se vraća pošiljatelju", "10000 Zagreb"),
      ),
    ]);
    expect(result.snapshots[0]?.status).toBe("returning");
    expect(result.snapshots[0]?.delivered).toBe(false);
  });

  it("marks a delivered parcel", async () => {
    const { result } = await run([
      found(row("18.11.2026 10:00:00", "Pošiljka je uručena primatelju", "10000 Zagreb")),
    ]);
    expect(result.snapshots[0]?.delivered).toBe(true);
    expect(result.snapshots[0]?.deliveredAt).toBe("2026-11-18T09:00:00.000Z");
  });

  it("treats the no-data notice as not found", async () => {
    const { result } = await run([
      page(
        "Hrvatska Pošta - Nema podataka",
        "<p>Nema podataka za uneseni prijamni broj pošiljke</p>",
      ),
    ]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports an unknown wording and keeps the last known status", async () => {
    const { result, unknown } = await run([
      found(
        row("18.11.2026 10:00:00", "Nova poruka", "10000 Zagreb"),
        row("17.11.2026 10:00:00", "Pošiljka je prispjela", "10000 Zagreb"),
      ),
    ]);
    expect(result.snapshots[0]?.status).toBe("in_transit");
    expect(result.snapshots[0]?.rawStatus).toBe("Nova poruka");
    expect(unknown).toEqual(["wording:Nova poruka"]);
  });

  it("stops fast on pages it does not recognise", async () => {
    await expect(run([page("Just a moment", "")])).rejects.toThrow(UnexpectedResponseError);
    await expect(run([page("Something else", "<p>hi</p>")])).rejects.toThrow(
      UnexpectedResponseError,
    );
    await expect(run([found()])).rejects.toThrow(UnexpectedResponseError);
    await expect(run([raw("", 302, JSON_TYPE)])).rejects.toThrow(TransientError);
    await expect(run([new Error("offline")])).rejects.toThrow(TransientError);
  });
});
