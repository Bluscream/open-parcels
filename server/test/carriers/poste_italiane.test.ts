import { describe, expect, it } from "vitest";
import { posteItaliane } from "../../src/carriers/poste_italiane/index.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, onPrefix, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "TE000000001IT";
const OTHER = "TE000000002IT";
const API = "POST www.poste.it/online/dovequando/DQ-REST/ricercasemplice";

const at = (iso: string) => Date.parse(iso);

function record(latest: string, extra: Record<string, unknown> = {}) {
  return {
    esitoRicerca: "3",
    idTracciatura: CODE,
    stato: "2",
    dataPrevistaConsegna: "Consegna prevista entro venerdì 20 novembre 2026",
    listaMovimenti: [
      {
        dataOra: at("2026-11-16T09:00:00Z"),
        statoLavorazione: "La spedizione e' stata presa in carico",
      },
      { dataOra: at("2026-11-17T09:00:00Z"), statoLavorazione: "La spedizione è in transito" },
      {
        dataOra: at("2026-11-18T09:00:00Z"),
        statoLavorazione: latest,
        denominazioneUfficio: "Ufficio Prova",
        indirizzoUfficio: "Via Esempio 1",
      },
    ],
    ...extra,
  };
}

describe("Poste Italiane tracking", () => {
  it("maps the Italian wording, reads the estimate as a local day and keeps the history", async () => {
    const world = new World(posteItaliane, [
      onPrefix(API, json(record("La spedizione è in consegna"))),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      carrier: "poste_italiane",
      barcode: CODE,
      status: "out_for_delivery",
      delivered: false,
      plannedFrom: "2026-11-19T23:00:00.000Z",
      plannedTo: "2026-11-20T22:59:59.000Z",
      pickupPoint: null,
    });
    expect(parcel?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(world.calls[0]?.body).toContain(CODE);
  });

  it("names the office only for a collectable parcel", async () => {
    const world = new World(posteItaliane, [
      onPrefix(API, json(record("Disponibile per il ritiro presso l'ufficio"))),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "Ufficio Prova, Via Esempio 1",
    });
  });

  it("takes Poste's delivered flag over the wording", async () => {
    const world = new World(posteItaliane, [
      onPrefix(API, json(record("La spedizione è stata consegnata", { stato: "5" }))),
    ]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T09:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats the not-found outcomes as not found", async () => {
    const world = new World(posteItaliane, [
      onPrefix(API, json({ esitoRicerca: "1" }), json({ esitoRicerca: "2" })),
    ]);
    expect((await world.track([CODE, OTHER, "../x"])).snapshots).toEqual([]);
    expect(world.calls).toHaveLength(2);
  });

  it("reports new wording and falls back to the newest mapped event", async () => {
    const world = new World(posteItaliane, [onPrefix(API, json(record("Qualcosa di nuovo")))]);
    const [parcel] = (await world.track([CODE])).snapshots;
    expect(parcel).toMatchObject({ status: "in_transit", rawStatus: "Qualcosa di nuovo" });
    expect(world.unknown).toEqual(["status_text:Qualcosa di nuovo"]);
  });

  it("stops on an unknown envelope and on a network error", async () => {
    const odd = new World(posteItaliane, [onPrefix(API, json({ esitoRicerca: "9" }))]);
    await expect(odd.track([CODE])).rejects.toBeInstanceOf(UnexpectedResponseError);
    const offline = new World(posteItaliane, [onPrefix(API, new TypeError("offline"))]);
    await expect(offline.track([CODE, OTHER])).rejects.toBeInstanceOf(TransientError);
    expect(offline.calls).toHaveLength(1);
  });
});
