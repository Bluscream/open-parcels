import { describe, expect, it } from "vitest";
import { tipsa } from "../../src/carriers/tipsa/index.js";
import { register } from "../../src/engine/registry.js";
import { CaptchaError, TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeFetch, type Reply } from "./fake-carrier.js";

// Made-up values only.
const AGENCY = "990001";
const ORIGIN = "990002";
const WAYBILL = "00000001";
const CODE = `${AGENCY}${ORIGIN}${WAYBILL}`;
const SERVICE = "00000000-0000-4000-8000-000000000001";
const LOOKUP = "GET aplicaciones.tip-sa.com/cliente/datos_prestashop.php";
const DETAIL = "GET dinapaqweb.tipsa-dinapaq.com/dinapaqweb/detalle_envio.php";
const plugin = register(tipsa);
const config = { postalCode: "99 999" };

function door(service: string, date: string): Reply {
  const target = `https://dinapaqweb.tipsa-dinapaq.com/dinapaqweb/detalle_envio.php?servicio=${service}&fecha=${date}`;
  return {
    status: 200,
    raw: `<html><head><meta http-equiv="refresh" content="0; url=${target}"></head></html>`,
  };
}

const field = (label: string, value: string) =>
  `<div class="mdl-grid"><div class="mdl-cell--2-col color-accent">${label}</div><div class="mdl-cell--4-col">${value}</div></div>`;

const row = (when: string, status: string, town: string) =>
  `<tr><td>${when}<span class="mdl-tooltip">${when}</span></td><td>${status}</td><td>${town}</td></tr>`;

function page(status: string, rows: string[], code = CODE): Reply {
  const html = `<html><body>
<input id="envio-localizado" value="${code}"><input id="estado-localizado" value="${status}">
<input id="CodAgeCargo" value="${AGENCY}"><input id="CodAgeOri" value="${ORIGIN}"><input id="Albaran" value="${WAYBILL}">
<script>var a = "<div>ignored</div>";</script>
<div class="panel"><div class="panel-datos">DATOS GENERALES</div>
${field("Remitente", "Tienda de Ejemplo")}${field("Kilos", "2,5")}
${field("Destinatario", "P***** E*****")}${field("Dirección", "Calle Inventada 1")}
</div>
<div class="panel"><div class="panel-datos">DATOS DE LA ENTREGA</div>${field("Fecha", "18/11/26")}${field("Hora", "11:30")}</div>
<table><thead><tr><th>Fecha/Hora</th><th>Estado</th><th>Población</th></tr></thead>
<tbody>${rows.join("")}</tbody></table></body></html>`;
  return { status: 200, raw: Buffer.from(html, "latin1") };
}

const ROWS = [
  row("18/11/26 08:15", "EN REPARTO", "PUEBLO INVENTADO"),
  row("17/11/26 22:40", "TRÁNSITO", "CIUDAD FICTICIA"),
  row("17/11/26 10:00", "DOCUMENTADO", "CIUDAD FICTICIA"),
];

describe("TIPSA tracking", () => {
  it("passes the postcode gate and reads status, weight and history from the Latin-1 page", async () => {
    const { fetchImpl, calls } = fakeFetch({
      [LOOKUP]: [door(SERVICE, "17/11/26")],
      [DETAIL]: [page("EN REPARTO", ROWS)],
    });
    const { base, unknown } = fakeContext(tipsa.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    const parcel = result.snapshots[0];
    expect(parcel).toMatchObject({
      carrier: "tipsa",
      barcode: CODE,
      status: "out_for_delivery",
      delivered: false,
      sender: "Tienda de Ejemplo",
      receiver: null,
      weightKg: 2.5,
      // The page carries no delivery window.
      plannedFrom: null,
      plannedTo: null,
    });
    expect(parcel?.history.map((event) => [event.at, event.status, event.rawStatus])).toEqual([
      ["2026-11-18T07:15:00.000Z", "out_for_delivery", "EN REPARTO"],
      ["2026-11-17T21:40:00.000Z", "in_transit", "TRÁNSITO"],
      ["2026-11-17T09:00:00.000Z", "registered", "DOCUMENTADO"],
    ]);
    const raw = JSON.stringify(parcel?.raw);
    expect(raw).not.toContain("Calle Inventada");
    expect(raw).not.toContain("P*****");
    expect(calls[0]?.url.searchParams.get("cp")).toBe("99999");
    expect(unknown).toEqual([]);
  });

  it("takes the delivery time from the delivered history row", async () => {
    const { fetchImpl } = fakeFetch({
      [LOOKUP]: [door(SERVICE, "17/11/26")],
      [DETAIL]: [
        page("ENTREGADO", [row("18/11/26 11:31", "ENTREGADO", "PUEBLO INVENTADO"), ...ROWS]),
      ],
    });
    const { base } = fakeContext(tipsa.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T10:31:00.000Z",
    });
  });

  it("treats an empty refresh target as not found", async () => {
    const { fetchImpl, calls } = fakeFetch({ [LOOKUP]: [door("", "")] });
    const { base } = fakeContext(tipsa.http, fetchImpl);
    expect(await plugin.track(base, config, null, [CODE])).toEqual({
      snapshots: [],
      complete: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("reports an unknown wording and falls back to the newest mapped row", async () => {
    const { fetchImpl } = fakeFetch({
      [LOOKUP]: [door(SERVICE, "17/11/26")],
      [DETAIL]: [page("ESTADO INVENTADO", ROWS)],
    });
    const { base, unknown } = fakeContext(tipsa.http, fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    expect(result.snapshots[0]).toMatchObject({
      status: "out_for_delivery",
      rawStatus: "ESTADO INVENTADO",
    });
    expect(unknown).toEqual(["ESTADO INVENTADO"]);
  });

  it("stops fast on a refused postcode, a foreign address, another shipment or a bot check", async () => {
    const { fetchImpl } = fakeFetch({
      [LOOKUP]: [
        { status: 200, raw: "<p>Error en el CP</p>" },
        {
          status: 200,
          raw: '<meta http-equiv="refresh" content="0; url=https://example.invalid/x">',
        },
        door(SERVICE, "17/11/26"),
        door(SERVICE, "17/11/26"),
      ],
      [DETAIL]: [
        page("EN REPARTO", ROWS, "99000000000009"),
        { status: 200, raw: "<title>Just a moment...</title>" },
      ],
    });
    const { base } = fakeContext(tipsa.http, fetchImpl);
    await expect(plugin.track(base, config, null, [CODE])).rejects.toBeInstanceOf(TransientError);
    await expect(plugin.track(base, config, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(plugin.track(base, config, null, [CODE])).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
    await expect(plugin.track(base, config, null, [CODE])).rejects.toBeInstanceOf(CaptchaError);
  });
});
