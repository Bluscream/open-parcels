import { describe, expect, it } from "vitest";
import { seur } from "../../src/carriers/seur/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { register } from "../../src/engine/registry.js";
import { fakeContext, fakeNetwork, json, routeTable, type Answer } from "./harness.js";

/** Routes by `METHOD host/path`; anything unscripted answers 404 with {}. */
const network = (table: Record<string, Answer[]>) =>
  fakeNetwork([routeTable(table)], () => json({}, 404));

const plugin = register(seur);

// Made-up values only.
const EMAIL = "tester@example.invalid";
const secret = { username: EMAIL, password: ["made", "up"].join("-") };
const TOKEN = "POST sso.seur.com/auth/realms/WEB_PUBLICA_PRO/protocol/openid-connect/token";
const PROFILE = "POST www.seur.com/miseur-contratacion/backend/consultarDatosUsuario";
const INBOX = "POST www.seur.com/miseur-contratacion/backend/consultarMisEnvios";

const token = (n: number): Answer => json({ access_token: `at-${n}` }, 200);
const profile = (): Answer => json({ usuario: { uuid: "u-1", username: EMAIL } }, 200);

function shipment(code: string, situations: [string, string][], extra: object = {}) {
  return {
    clave_envio: code,
    remitente: { razon_social: "Tienda de Prueba" },
    destinatario: { nombre_contacto: "Persona Prueba", centro_seur: "Tienda Uno" },
    peso: 1.5,
    situaciones: situations.map(([cod_situacion, fecha]) => ({ cod_situacion, fecha })),
    ...extra,
  };
}

const lists = (recibidos: unknown[], enviados: unknown[] = []): Answer =>
  json({ recibidos, enviados }, 200);

describe("SEUR account", () => {
  it("signs in, stores the token and maps incoming and outgoing shipments", async () => {
    const { fetchImpl, calls } = network({
      [TOKEN]: [token(1)],
      [PROFILE]: [profile()],
      [INBOX]: [
        lists(
          [
            shipment("TEST0001", [
              ["LC003", "2026-11-18T08:00:00Z"],
              ["LI567", "2026-11-17T08:00:00Z"],
              ["SX010", "2026-11-16T08:00:00Z"],
            ]),
          ],
          [shipment("TEST0002", [["LL003", "2026-11-15T08:00:00Z"]])],
        ),
      ],
    });
    const { base, saved } = fakeContext(seur.http, fetchImpl);
    const result = await plugin.fetchAccount(base, {}, secret);
    expect(result.complete).toBe(true);
    expect(result.snapshots[0]).toMatchObject({
      carrier: "seur",
      barcode: "TEST0001",
      direction: "incoming",
      status: "out_for_delivery",
      plannedFrom: null,
      plannedTo: null,
      sender: "Tienda de Prueba",
      receiver: "Persona Prueba",
      weightKg: 1.5,
    });
    expect(result.snapshots[0]?.history.map((e) => e.status)).toEqual([
      "out_for_delivery",
      "in_transit",
      "registered",
    ]);
    expect(result.snapshots[1]).toMatchObject({
      direction: "outgoing",
      delivered: true,
      deliveredAt: "2026-11-15T08:00:00.000Z",
    });
    expect(saved).toEqual([{ accessToken: "at-1", uuid: "u-1", username: EMAIL }]);
    expect(calls.at(-1)?.headers.get("authorization")).toBe("Bearer at-1");
  });

  it("returns an empty list when the account has no shipments", async () => {
    const { fetchImpl } = network({
      [TOKEN]: [token(1)],
      [PROFILE]: [profile()],
      [INBOX]: [lists([])],
    });
    const { base } = fakeContext(seur.http, fetchImpl);
    expect((await plugin.fetchAccount(base, {}, secret)).snapshots).toEqual([]);
  });

  it("reports an unknown situation code", async () => {
    const { fetchImpl } = network({
      [TOKEN]: [token(1)],
      [PROFILE]: [profile()],
      [INBOX]: [lists([shipment("TEST0003", [["ZZ999", "2026-11-18T08:00:00Z"]])])],
    });
    const { base, unknownKeys: unknown } = fakeContext(seur.http, fetchImpl);
    const [parcel] = (await plugin.fetchAccount(base, {}, secret)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(unknown).toEqual(["ZZ999"]);
  });

  it("raises SignInRejectedError when SEUR refuses the password", async () => {
    const { fetchImpl } = network({
      [TOKEN]: [json({ error: "invalid_grant" }, 401)],
    });
    const { base } = fakeContext(seur.http, fetchImpl);
    await expect(plugin.fetchAccount(base, {}, secret)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("never signs in again after a network error", async () => {
    const stored = { accessToken: "at-0", uuid: "u-1", username: EMAIL };
    const { fetchImpl, calls } = network({ [INBOX]: [new Error("socket hang up")] });
    const { base } = fakeContext(seur.http, fetchImpl, { session: stored });
    await expect(plugin.fetchAccount(base, {}, secret)).rejects.toBeInstanceOf(TransientError);
    expect(calls.map((c) => c.key)).toEqual([INBOX]);
  });

  it("renews a refused token exactly once", async () => {
    const stored = { accessToken: "at-0", uuid: "u-1", username: EMAIL };
    const { fetchImpl, calls } = network({
      [INBOX]: [json({}, 401), json({}, 401)],
      [TOKEN]: [token(2)],
      [PROFILE]: [profile()],
    });
    const { base } = fakeContext(seur.http, fetchImpl, { session: stored });
    await expect(plugin.fetchAccount(base, {}, secret)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(calls.filter((c) => c.key === TOKEN)).toHaveLength(1);
  });

  it("stops on a shipment list with the wrong shape", async () => {
    const { fetchImpl } = network({
      [TOKEN]: [token(1)],
      [PROFILE]: [profile()],
      [INBOX]: [json({ recibidos: "nope" }, 200)],
    });
    const { base } = fakeContext(seur.http, fetchImpl);
    await expect(plugin.fetchAccount(base, {}, secret)).rejects.toThrow(/unexpected shape/);
  });
});
