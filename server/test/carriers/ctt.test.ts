import { beforeEach, describe, expect, it } from "vitest";
import { ctt } from "../../src/carriers/ctt/index.js";
import { resetPortal } from "../../src/carriers/ctt/portal.js";
import { TransientError } from "../../src/plugin/errors.js";
import { json, onFragment, World, type Route } from "./harness.js";

// Made-up codes and values only.
const S10 = "RR000000000PT";
const EXPRESS = "00000000000001";
const SCRIPT_PATH = "/CustomerArea/scripts/CustomerArea.CustomerArea.PublicArea_Detail.mvc.js";

/** The keyless version endpoints and a script naming both actions' versions. */
function versionRoutes(): Route[] {
  return [
    onFragment("/moduleversioninfo", json({ versionToken: "mv-1" })),
    onFragment("/moduleinfo", json({ manifest: { urlVersions: { [SCRIPT_PATH]: "sv-1" } } })),
    onFragment(
      ".mvc.js",
      new Response(
        'controller.callDataAction("DataActionGetObjectEventsByInputObjectCode", "x", "api-1");' +
          'controller.callDataAction("DataActionCheckIPLocked", "x", "api-2");',
      ),
    ),
  ];
}

const bootstrap = () =>
  new Response("Invalid Login", {
    status: 403,
    headers: { "set-cookie": "nr2Users=crf%3dtoken%2Babc%3buid%3d0%3bunm%3d; path=/" },
  });

function record(stateIds: [number, string, string][]) {
  return {
    data: {
      ObjectEventsFromQuery: {
        Found: true,
        ObjectCode: S10,
        Sender: "Example Shop",
        Events: {
          List: stateIds.map(([StateId, State, DateTime]) => ({
            StateId,
            State,
            Event: `${State} (event)`,
            DateTime,
            Local: "Test Office",
          })),
        },
      },
    },
  };
}

describe("CTT tracking", () => {
  beforeEach(() => {
    resetPortal();
  });

  it("bootstraps the anonymous session and maps the newest event", async () => {
    const world = new World(ctt);
    world.routes = [
      ...versionRoutes(),
      onFragment(
        "DataActionGetObjectEventsByInputObjectCode",
        bootstrap(),
        json(
          record([
            [7, "Em entrega", "2026-11-18T08:00:00Z"],
            [11, "Em trânsito", "2026-11-17T08:00:00Z"],
          ]),
        ),
      ),
    ];
    const [parcel] = (await world.track([S10], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      carrier: "ctt",
      status: "out_for_delivery",
      rawStatus: "Em entrega",
      sender: "Example Shop",
    });
    expect(parcel?.history.map((e) => e.status)).toEqual(["out_for_delivery", "in_transit"]);
    const retry = world.calls.filter((c) => c.url.pathname.endsWith("ObjectCode")).at(-1);
    const headers = new Headers(retry?.init.headers);
    expect(headers.get("x-csrftoken")).toBe("token+abc");
    expect(headers.get("user-agent")).toContain("Mozilla");
    expect(JSON.parse(retry?.body ?? "")).toMatchObject({
      versionInfo: { moduleVersion: "mv-1", apiVersion: "api-1" },
    });
  });

  it("returns nothing for a genuine not-found and fails during maintenance", async () => {
    const world = new World(ctt);
    world.routes = [
      ...versionRoutes(),
      onFragment("ObjectCode", json({ data: { ObjectEventsFromQuery: { Found: false } } })),
      onFragment(
        "CheckIPLocked",
        json({ data: { IsMaintenance: false } }),
        json({ data: { IsMaintenance: true } }),
      ),
    ];
    expect((await world.track([S10], {}, null)).snapshots).toEqual([]);
    await expect(world.track([S10], {}, null)).rejects.toBeInstanceOf(TransientError);
  });

  it("reports an unmapped state id", async () => {
    const world = new World(ctt);
    world.routes = [
      ...versionRoutes(),
      onFragment("ObjectCode", json(record([[99, "Novo", "2026-11-18T08:00:00Z"]]))),
    ];
    const [parcel] = (await world.track([S10], {}, null)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(world.unknown).toEqual(["status_code:99"]);
  });

  it("routes all-digit codes to CTT Express and reads its revised date", async () => {
    const world = new World(ctt);
    world.routes = [
      onFragment(
        "p_track_redis_v2.php",
        json({
          error: null,
          data: {
            shipping_history: {
              events: [
                {
                  type: "STATUS",
                  code: "1000",
                  description: "Sent",
                  event_date: "2026-11-17T08:00:00Z",
                },
                {
                  type: "MANAGEMENTS",
                  code: "71_INAT",
                  event_date: "2026-11-17T09:00:00Z",
                  detail: { delivery_date: "2026-11-19" },
                },
              ],
            },
          },
        }),
      ),
    ];
    const [parcel] = (await world.track([EXPRESS], {}, null)).snapshots;
    expect(parcel).toMatchObject({
      status: "in_transit",
      barcode: EXPRESS,
      plannedFrom: "2026-11-18T23:00:00.000Z",
    });
    expect(world.calls).toHaveLength(1);
  });

  it("treats an empty CTT Express answer as not found", async () => {
    const world = new World(ctt);
    world.routes = [onFragment("p_track_redis_v2.php", new Response(""))];
    expect((await world.track([EXPRESS], {}, null)).snapshots).toEqual([]);
  });
});
