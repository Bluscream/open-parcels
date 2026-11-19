import { describe, expect, it } from "vitest";
import { swissPost } from "../../src/carriers/swiss_post/index.js";
import { SignInRejectedError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { json, madeUp, on, World } from "./harness.js";

// Made-up mailpiece ids and tokens only.
const TOKEN = "POST login.swissid.ch/idp/oauth2/access_token";
const OVERVIEW = "GET app.post.ch/mobserv/v1/mailpiece/tracking/overview";
const SECRET = { refreshToken: madeUp("refresh"), deviceId: "device-1" };
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;

describe("Swiss Post account", () => {
  it("bears the id token, saves the rotated refresh token and skips letters", async () => {
    const id = jwt(1_900_000_000);
    const world = new World(swissPost, [
      on(
        TOKEN,
        json({ id_token: id, refresh_token: madeUp("refresh", "2"), access_token: "opaque" }),
      ),
      on(
        OVERVIEW,
        json({
          inProgress: [
            {
              mailpieceId: "990000000000000001",
              mailpieceStatusType: "WAITING_FOR_PICKUP",
              deliveryAddress: { pickupOffice: { name: "Test Office" } },
            },
            { mailpieceId: "990000000000000002", mailpieceType: "LETTER" },
          ],
          completed: [
            {
              mailpieceId: "990000000000000003",
              mailpieceStatusType: "DELIVERED",
              userIsSender: true,
              statusTimestamp: 1_795_000_000_000,
            },
          ],
        }),
      ),
    ]);
    const result = await world.fetchAccount({}, SECRET);
    expect(world.calls[1]?.headers.get("authorization")).toBe(`Bearer ${id}`);
    expect(world.calls[1]?.headers.get("x-device-id")).toBe("device-1");
    expect(world.saved[0]).toMatchObject({ refreshToken: madeUp("refresh", "2") });
    expect(
      result.snapshots.map((parcel) => [parcel.status, parcel.pickupPoint, parcel.direction]),
    ).toEqual([
      ["at_pickup_point", "Test Office", "incoming"],
      ["delivered", null, "outgoing"],
    ]);
  });

  it("asks for a new sign-in when SwissID refuses the refresh token", async () => {
    const world = new World(swissPost, [on(TOKEN, json({ error: "invalid_grant" }, 400))]);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
  });

  it("does not ask for a sign-in on a 400 that carries no OAuth error", async () => {
    const world = new World(swissPost, [on(TOKEN, json({ message: "bad gateway page" }, 400))]);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  const tokens = () =>
    on(TOKEN, json({ id_token: jwt(1_900_000_000), refresh_token: madeUp("refresh", "2") }));

  it.each([
    ["a missing list", { inProgress: [] }],
    ["an error object", { error: "maintenance" }],
  ])("stops on %s instead of reading an empty account", async (_name, body) => {
    const world = new World(swissPost, [tokens(), on(OVERVIEW, json(body))]);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("is not complete when a parcel has no id", async () => {
    const world = new World(swissPost, [
      tokens(),
      on(OVERVIEW, json({ inProgress: [{ mailpieceStatusType: "DELIVERED" }], completed: [] })),
    ]);
    expect((await world.fetchAccount({}, SECRET)).complete).toBe(false);
  });

  it("renews only once per run: a token renewed for its age is not renewed again after a 401", async () => {
    const world = new World(swissPost, [tokens(), on(OVERVIEW, json({}, 401))]);
    await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    expect(world.requests().filter((key) => key === TOKEN)).toHaveLength(1);
  });
});
