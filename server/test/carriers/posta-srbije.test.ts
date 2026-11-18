import { describe, expect, it } from "vitest";
import { postaSrbije } from "../../src/carriers/posta_srbije/index.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, on, World } from "./harness.js";

// Made-up item numbers and places only.
const CODE = "RA000000001RS";
const URL_KEY = "POST api.posta.rs/paketi";

const scan = (code: string, at: string, extra: Record<string, unknown> = {}) => ({
  PrijemniBroj: CODE,
  ApiStatusSifra: code,
  DatumKretanja: at,
  Mesto: "11000 TESTGRAD",
  Status: `Scan ${code}`,
  Potpisnik: "Test Person",
  ...extra,
});

const answer = (events: unknown[]) => ({
  Rezultat: 0,
  StrOut: JSON.stringify({ Kretanja: events }),
});

describe("Pošta Srbije tracking", () => {
  it("reads scans newest first, in Belgrade time, and keeps the signer out of raw", async () => {
    const world = new World(postaSrbije, [
      on(
        URL_KEY,
        json(
          answer([
            scan("UR", "2026-11-18T10:00:00"),
            scan("OT", "2026-11-17T10:00:00", { Mesto: "DE-TEST" }),
            scan("PR", "2026-11-16T10:00:00", { Masa: 1500 }),
          ]),
        ),
      ),
    ]);
    const [found] = (await world.track([CODE])).snapshots;
    const sent = JSON.parse(world.calls[0]?.body ?? "{}") as { StrIn: string };
    expect(JSON.parse(sent.StrIn)).toMatchObject({ PrijemniBroj: CODE });
    expect(found).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T09:00:00.000Z",
      weightKg: 1.5,
    });
    expect(found?.history.map((event) => event.status)).toEqual([
      "delivered",
      "in_transit",
      "registered",
    ]);
    expect(JSON.stringify(found?.raw)).not.toContain("Test Person");
  });

  it("reads a delivery on the return leg as returning", async () => {
    const world = new World(postaSrbije, [
      on(URL_KEY, json(answer([scan("UR", "2026-11-18T10:00:00", { Retur: "D" })]))),
    ]);
    expect((await world.track([CODE])).snapshots[0]?.status).toBe("returning");
  });

  it("accepts only the carrier's not-found notice as absent", async () => {
    const world = new World(postaSrbije, [
      on(
        URL_KEY,
        json({
          Rezultat: 1,
          StrRezultat: JSON.stringify({
            PorukaKorisnik:
              "Postal item not found. Please check the accuracy of the number you entered.",
          }),
        }),
        json({ Rezultat: 3 }),
        json(answer([{ ...scan("PR", "2026-11-16T10:00:00"), PrijemniBroj: "OTHER" }])),
      ),
    ]);
    expect((await world.track([CODE])).snapshots).toEqual([]);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(world.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
