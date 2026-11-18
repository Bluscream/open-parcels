import { describe, expect, it } from "vitest";
import { eltaCourier } from "../../src/carriers/elta-courier/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError } from "../../src/plugin/errors.js";
import { harness, scripted } from "./kit-harness.js";

// Made-up codes and values only.
const CODE = "EL000000001GR";
const ROUTE = "POST www.elta-courier.gr/track.php";
const plugin = register(eltaCourier);

const event = (date: string, time: string, status: string) => ({
  date,
  time,
  status,
  place: "Κέντρο Α",
});

function reply(...events: ReturnType<typeof event>[]) {
  // The real endpoint prefixes its JSON with a byte-order mark.
  return String.fromCharCode(0xfeff) + JSON.stringify({ result: { [CODE]: { result: events } } });
}

describe("ELTA Courier tracking", () => {
  it("reads Greek local times, maps the newest sentence and keeps the place", async () => {
    const { fetchImpl, calls } = scripted({
      [ROUTE]: [
        {
          status: 200,
          raw: reply(
            event("17-11-2026", "10:00", "Δημιουργία ΣΥ.ΔΕ.ΤΑ."),
            event("18-11-2026", "08:30", "Σε διανομέα προς παράδοση"),
          ),
        },
      ],
    });
    const { base, unknown } = harness(eltaCourier.http, fetchImpl);
    const [found] = (await plugin.track(base, {}, null, [CODE])).snapshots;
    expect(calls[0]?.body).toBe(`number=${CODE}`);
    expect(found).toMatchObject({
      carrier: "elta-courier",
      status: "out_for_delivery",
      rawStatus: "Σε διανομέα προς παράδοση",
      plannedFrom: null,
    });
    expect(found?.history[0]).toEqual({
      at: "2026-11-18T06:30:00.000Z",
      status: "out_for_delivery",
      rawStatus: "Σε διανομέα προς παράδοση",
      location: "Κέντρο Α",
    });
    expect(unknown).toEqual([]);
  });

  it("dates a delivery and treats an empty result as not found", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [
        { status: 200, raw: reply(event("18-11-2026", "12:00", "Αποστολή παραδόθηκε")) },
        { status: 200, body: { result: [] } },
      ],
    });
    const { base } = harness(eltaCourier.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots[0]).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-11-18T10:00:00.000Z",
    });
    expect((await plugin.track(base, {}, null, [CODE])).snapshots).toEqual([]);
  });

  it("reports an unknown sentence and fails transiently on a server error", async () => {
    const { fetchImpl } = scripted({
      [ROUTE]: [
        { status: 200, raw: reply(event("18-11-2026", "12:00", "Κάτι νέο")) },
        { status: 500, raw: "" },
      ],
    });
    const { base, unknown } = harness(eltaCourier.http, fetchImpl);
    expect((await plugin.track(base, {}, null, [CODE])).snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["status:Κάτι νέο"]);
    await expect(plugin.track(base, {}, null, [CODE])).rejects.toBeInstanceOf(TransientError);
  });
});
