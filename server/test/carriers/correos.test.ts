import { describe, expect, it } from "vitest";
import { correos } from "../../src/carriers/correos/index.js";
import { UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, onFragment, World } from "./harness.js";

// Made-up codes and values only.
const CODE = "PQ00000000000000000T";

const event = (
  codEvento: string,
  fecEvento: string,
  horEvento: string,
  desTextoResumen: string,
) => ({
  codEvento,
  fecEvento,
  horEvento,
  desTextoResumen,
});

describe("Correos tracking", () => {
  it("reads status, weight, pickup office and history in Spanish time", async () => {
    const world = new World(correos);
    world.routes = [
      onFragment(
        `/eventos_envio_servicio/${CODE}`,
        json([
          {
            codEnvio: CODE,
            error: { codError: "0" },
            peso: "380",
            nom_codired: "OFICINA DE PRUEBA",
            eventos: [
              event("A010000V", "16/11/2026", "09:00:00", "Admitido"),
              event("H01I350V", "18/11/2026", "11:30:00", "Disponible para recoger"),
            ],
          },
        ]),
      ),
    ];
    const [parcel] = (await world.track([CODE], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "correos",
      status: "at_pickup_point",
      pickup: true,
      pickupPoint: "OFICINA DE PRUEBA",
      weightKg: 0.38,
      rawStatus: "Disponible para recoger",
    });
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-18T10:30:00.000Z", "at_pickup_point"],
      ["2026-11-16T08:00:00.000Z", "registered"],
    ]);
  });

  it("treats a non-zero error code as not found", async () => {
    const world = new World(correos);
    world.routes = [
      onFragment("/eventos_envio_servicio/", json([{ error: { codError: "1", desError: "x" } }])),
    ];
    expect((await world.track([CODE], {}, null)).snapshots).toEqual([]);
  });

  it("reports an unmapped event code", async () => {
    const world = new World(correos);
    world.routes = [
      onFragment(
        "/eventos_envio_servicio/",
        json([
          {
            error: { codError: "0" },
            eventos: [event("Z999999V", "18/11/2026", "08:00:00", "Nuevo")],
          },
        ]),
      ),
    ];
    const [parcel] = (await world.track([CODE], {}, null)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:Z999999V"]);
  });

  it("stops on an answer without an envelope", async () => {
    const world = new World(correos);
    world.routes = [onFragment("/eventos_envio_servicio/", json([]))];
    await expect(world.track([CODE], {}, null)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
