import { describe, expect, it } from "vitest";
import { anPost } from "../../src/carriers/an_post/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/errors.js";
import { json, madeUp, on, World } from "./harness.js";

// Made-up codes, ids and names only.
const CODE = "CE000000001IE";
const secret = { username: "test@example.invalid", password: madeUp("pw") };
const BOOT = "GET identity.anpost.com/accounts.webSdkBootstrap";
const LOGIN = "POST identity.anpost.com/accounts.login";
const JWT = "POST identity.anpost.com/accounts.getJWT";
const ITEMS =
  "GET apim-anpost-mydeliveries.anpost.com/an-post-my-deliveries-api/v2/api/customer/uid-1/trackingitems";

const signedIn = () =>
  json({
    errorCode: 0,
    UID: "uid-1",
    sessionInfo: { cookieValue: madeUp("login") },
  });
const jwt = () => json({ errorCode: 0, id_token: madeUp("id") });

function items(...trackingItems: unknown[]) {
  return json({ success: true, errors: [], trackingItems });
}

const item = (category: number, extra: Record<string, unknown> = {}) => ({
  trackingNumber: CODE,
  lastTrackingEventCategoryId: category,
  estimatedDeliveryDateTime: "2026-11-20T10:00:00",
  retailerName: "Example Shop",
  recipientName: "Test Person",
  deliveryPin: "0000",
  ...extra,
});

function signInRoutes(w: World): void {
  w.routes.push(
    on(BOOT, json({ hasGmid: true }, 200, { "set-cookie": "gmid=gm-1; Path=/" })),
    on(LOGIN, signedIn()),
  );
}

describe("An Post account", () => {
  it("signs in once, reads the deliveries and keeps the session", async () => {
    const w = new World(anPost);
    signInRoutes(w);
    w.routes.push(on(JWT, jwt()), on(ITEMS, items(item(3))));
    const result = await w.fetchAccount({}, secret);
    expect(result.complete).toBe(true);
    const [parcel] = result.snapshots;
    expect(parcel).toMatchObject({
      carrier: "an_post",
      barcode: CODE,
      status: "in_transit",
      rawStatus: "3",
      plannedFrom: "2026-11-20T10:00:00.000Z",
      plannedTo: null,
      sender: "Example Shop",
      history: [],
    });
    expect(JSON.stringify(parcel?.raw)).not.toContain("deliveryPin");
    expect(new URLSearchParams(w.calls[1]?.body ?? "").get("gmid")).toBe("gm-1");
    expect(w.calls[3]?.headers.get("authorization")).toBe(secret.password.replace("pw", "id"));
    expect(w.stored).toMatchObject({ uid: "uid-1", gmid: "gm-1" });
  });

  it("reuses the stored session and reads a delivery in Irish summer time", async () => {
    const w = new World(anPost);
    w.stored = { uid: "uid-1", loginToken: madeUp("login"), gmid: "gm-1" };
    w.routes = [
      on(JWT, jwt()),
      on(ITEMS, items(item(4, { dateDelivered: "2026-07-01T12:00:00" }))),
    ];
    const [parcel] = (await w.fetchAccount({}, secret)).snapshots;
    expect(parcel).toMatchObject({
      status: "delivered",
      deliveredAt: "2026-07-01T11:00:00.000Z",
      plannedFrom: null,
    });
    expect(w.requests()).toEqual([JWT, ITEMS]);
  });

  it("returns an empty account as complete", async () => {
    const w = new World(anPost);
    w.stored = { uid: "uid-1", loginToken: madeUp("login"), gmid: "" };
    w.routes = [on(JWT, jwt()), on(ITEMS, items())];
    expect(await w.fetchAccount({}, secret)).toEqual({ snapshots: [], complete: true });
  });

  it("reports an unmapped category", async () => {
    const w = new World(anPost);
    w.stored = { uid: "uid-1", loginToken: madeUp("login"), gmid: "" };
    w.routes = [on(JWT, jwt()), on(ITEMS, items(item(42)))];
    const [parcel] = (await w.fetchAccount({}, secret)).snapshots;
    expect(parcel?.status).toBeNull();
    expect(w.unknown).toEqual(["category_id:42"]);
  });

  it("signs in again only when the service says the session expired", async () => {
    const w = new World(anPost);
    w.stored = { uid: "uid-1", loginToken: madeUp("old"), gmid: "" };
    signInRoutes(w);
    w.routes.push(on(JWT, json({ errorCode: 403007 }), jwt()), on(ITEMS, items()));
    await w.fetchAccount({}, secret);
    expect(w.requests()).toEqual([JWT, BOOT, LOGIN, JWT, ITEMS]);
  });

  it("tells wrong credentials apart from a network error", async () => {
    const refused = new World(anPost);
    refused.routes = [on(BOOT, json({})), on(LOGIN, json({ errorCode: 403042 }))];
    await expect(refused.fetchAccount({}, secret)).rejects.toBeInstanceOf(SignInRejectedError);

    const offline = new World(anPost);
    offline.stored = { uid: "uid-1", loginToken: madeUp("login"), gmid: "" };
    offline.routes = [on(JWT, new Error("offline"))];
    await expect(offline.fetchAccount({}, secret)).rejects.toBeInstanceOf(TransientError);
    expect(offline.requests()).toEqual([JWT]);
    expect(offline.stored).toMatchObject({ uid: "uid-1" });
  });
});
