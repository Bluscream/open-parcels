import { describe, expect, it } from "vitest";
import { mondialRelay } from "../../src/carriers/mondial_relay/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import type { FetchLike } from "../../src/plugin/http.js";
import { fakeContext, fakeNetwork, raw } from "./harness.js";

// Made-up codes and values only.
const CODE = "90000001";
const OTHER = "90000002";
const POSTCODE = "9999";
const config = { postcode: POSTCODE };
const plugin = register(mondialRelay);

const PAGE = '<html><div id="tracking" class="x" token="made:up-value"></div></html>';

function step(date: string) {
  return { Evenement: { Date: date } };
}

function expedition(steps: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    Numero: CODE,
    Enseigne: "XXSHOP01",
    DeliveryMode: "24R",
    EstimatedDeliveryDate: "2026-11-18T22:30:00",
    SuiviParEtapes: steps,
    Evenements: [
      { Date: "2026-11-16T10:00:00", Libelle: "Aangemeld" },
      { Date: "2026-11-17T08:00:00.12", Libelle: "Afgegeven in punt" },
      {
        Date: "2026-11-17T18:30:00",
        Libelle: "Klaar om op te halen",
        DetailPointRelais: { Adresse: { Libelle: "Testwinkel" } },
      },
    ],
    ...extra,
  };
}

/** A scripted reply: text bodies are sent as they are, anything else as JSON. */
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

const send = (reply: Reply, headers: Record<string, string> = {}) =>
  raw(
    typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body),
    reply.status,
    headers,
  );

/**
 * The tracking page (always `page`, setting a session cookie) and its lookup API (`lookups` in
 * order; 500 once they run out).
 */
function fakeSite(lookups: (Reply | Error)[], page: Reply = { status: 200, body: PAGE }) {
  const calls: { path: string; token: string | null; cookie: string | null }[] = [];
  const { fetchImpl } = fakeNetwork([
    (call) => {
      calls.push({
        path: call.url.pathname,
        token: call.headers.get("requestverificationtoken"),
        cookie: call.headers.get("cookie"),
      });
      if (call.url.pathname !== "/api/tracking") {
        return send(page, { "set-cookie": "sid=abc; Path=/" });
      }
      const reply = lookups.shift();
      if (reply === undefined) {
        return raw("{}", 500);
      }
      return reply instanceof Error ? reply : send(reply);
    },
  ]);
  return { fetchImpl, calls };
}

function context(fetchImpl: FetchLike) {
  const { base, unknown } = fakeContext(mondialRelay.http, fetchImpl);
  return { base, unknown };
}

describe("Mondial Relay tracking", () => {
  it("reads status, relay point, the whole-day window and step-tagged history", async () => {
    const body = {
      Expedition: expedition({
        "1": step("2026-11-16T10:00:00"),
        "2": step("2026-11-17T08:00:00.12"),
        "4": step("2026-11-17T18:30:00"),
        "5": {},
      }),
    };
    const { fetchImpl, calls } = fakeSite([{ status: 200, body }]);
    const { base, unknown } = context(fetchImpl);
    const result = await plugin.track(base, config, null, [CODE]);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "mondial_relay",
      barcode: CODE,
      status: "at_pickup_point",
      rawStatus: "4",
      pickup: true,
      pickupPoint: "Testwinkel",
      sender: "XXSHOP01",
      plannedFrom: "2026-11-17T23:00:00.000Z",
      plannedTo: "2026-11-18T22:59:59.000Z",
    });
    expect(parcel?.url).toContain("codeMarque=XX");
    expect(parcel?.url).not.toContain(POSTCODE);
    expect(parcel?.history.map((e) => [e.at, e.status])).toEqual([
      ["2026-11-17T17:30:00.000Z", "at_pickup_point"],
      ["2026-11-17T07:00:00.120Z", "in_transit"],
      ["2026-11-16T09:00:00.000Z", "registered"],
    ]);
    expect(unknown).toEqual([]);
    expect(calls[1]).toMatchObject({ token: "made:up-value", cookie: "sid=abc" });
  });

  it("marks a collected parcel delivered with the step's own time", async () => {
    const body = {
      Expedition: expedition({
        "4": step("2026-11-17T18:30:00"),
        "5": step("2026-11-18T12:00:00"),
      }),
    };
    const { fetchImpl } = fakeSite([{ status: 200, body }]);
    const { base } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, config, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      delivered: true,
      deliveredAt: "2026-11-18T11:00:00.000Z",
      plannedFrom: null,
    });
  });

  it("treats a status list without shipment as not found and skips implausible codes", async () => {
    const { fetchImpl, calls } = fakeSite([
      { status: 200, body: { Expedition: null, status: [{ message: "x" }] } },
    ]);
    const { base } = context(fetchImpl);
    const result = await plugin.track(base, config, null, [CODE, "../x"]);
    expect(result.snapshots).toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("reports an unknown step and falls back to the highest mapped one", async () => {
    const body = {
      Expedition: expedition({
        "2": step("2026-11-17T08:00:00"),
        "7": step("2026-11-18T08:00:00"),
      }),
    };
    const { fetchImpl } = fakeSite([{ status: 200, body }]);
    const { base, unknown } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, config, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ status: "in_transit", rawStatus: "7" });
    expect(unknown).toEqual(["step:7"]);
  });

  it("downgrades step 4 and reports an unconfirmed delivery mode", async () => {
    const body = {
      Expedition: expedition({ "4": step("2026-11-17T18:30:00") }, { DeliveryMode: "HOM" }),
    };
    const { fetchImpl } = fakeSite([{ status: 200, body }]);
    const { base, unknown } = context(fetchImpl);
    const [parcel] = (await plugin.track(base, config, null, [CODE])).snapshots;
    expect(parcel).toMatchObject({ status: "in_transit", pickup: false, pickupPoint: null });
    expect(unknown).toEqual(["delivery_mode:HOM"]);
  });

  it("stops on a network error, a refusal or a page without its value", async () => {
    const network = fakeSite([new Error("socket hang up")]);
    await expect(
      plugin.track(context(network.fetchImpl).base, config, null, [CODE, OTHER]),
    ).rejects.toBeInstanceOf(TransientError);
    expect(network.calls).toHaveLength(2);

    const refused = fakeSite([], { status: 403, body: "no" });
    await expect(
      plugin.track(context(refused.fetchImpl).base, config, null, [CODE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);

    const bare = fakeSite([], { status: 200, body: "<html></html>" });
    await expect(
      plugin.track(context(bare.fetchImpl).base, config, null, [CODE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
    expect(bare.calls).toHaveLength(1);
  });

  it("rejects an answer of the wrong shape", async () => {
    const { fetchImpl } = fakeSite([{ status: 200, body: { something: "else" } }]);
    await expect(
      plugin.track(context(fetchImpl).base, config, null, [CODE]),
    ).rejects.toBeInstanceOf(UnexpectedResponseError);
  });
});
