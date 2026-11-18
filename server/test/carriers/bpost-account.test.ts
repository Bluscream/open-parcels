import { describe, expect, it } from "vitest";
import { bpost } from "../../src/carriers/bpost/index.js";
import { carrierKey } from "../../src/plugin/rules.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, madeUp, on, World } from "./harness.js";

// Made-up item codes, accounts and tokens only.
const API = "POST mybpost.bpost.cloud/prod_v2";
const SECRET = { username: "user@example.com", password: madeUp("pass") };
const tokens = (access: string) => ({
  response: { accessToken: access, refreshToken: `r-${access}` },
});

describe("My bpost account", () => {
  it("signs in with the app key and version, lists the inbox and reads the details", async () => {
    const world = new World(bpost, [
      on(`${API}/users/login`, json(tokens("a1"))),
      on(
        `${API}/parcel/getparcelslist`,
        json({ response: { items: [{ itemCode: "323200000000000001", Status: "x" }] } }),
      ),
      on(
        `${API}/parcel/getparcelsv3`,
        json({
          response: {
            active: {
              group: [
                {
                  itemCode: "323200000000000001",
                  currentStatus: "OUT_FOR_DELIVERY",
                  eta: { day: "2026-11-18", time1: "10:00", time2: "12:00" },
                  sender: { name: "Example Shop" },
                },
              ],
            },
            history: [],
          },
        }),
      ),
    ]);
    const result = await world.fetchAccount({}, SECRET);
    expect(world.calls[0]?.headers.get("x-api-key")).toBe(carrierKey("bpost", "app_key"));
    expect(world.calls[0]?.headers.get("appversion")).toBe(carrierKey("bpost", "app_version"));
    expect(world.calls[1]?.headers.get("authorization")).toBe("a1");
    expect(result.snapshots[0]).toMatchObject({
      barcode: "323200000000000001",
      sender: "Example Shop",
      plannedFrom: "2026-11-18T09:00:00.000Z",
      plannedTo: "2026-11-18T11:00:00.000Z",
    });
    expect(world.stored).toEqual({ access: "a1", refresh: "r-a1" });
  });

  it("refreshes a refused token and treats an unsupported version as transient", async () => {
    const world = new World(bpost, [
      on(`${API}/parcel/getparcelslist`, json({}, 401), json({ dbError: "Err_1005" })),
      on(`${API}/users/refreshtoken`, json(tokens("a2"))),
    ]);
    world.stored = { access: "a1", refresh: "r-a1" };
    expect((await world.fetchAccount({}, SECRET)).snapshots).toEqual([]);
    expect(world.calls[1]?.headers.get("appversion")).toBeNull();
    const old = new World(bpost, [
      on(`${API}/users/login`, json({ code: "APPVERSION_NOT_SUPPORTED" }, 403)),
    ]);
    await expect(old.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(TransientError);
    const wrong = new World(bpost, [
      on(`${API}/users/login`, json({ code: "BAD_CREDENTIALS" }, 401)),
    ]);
    await expect(wrong.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
  });
});
