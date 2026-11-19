import { describe, expect, it } from "vitest";
import { usps } from "../../src/carriers/usps/index.js";
import { enrolledAddresses } from "../../src/carriers/usps/journey.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
} from "../../src/plugin/api.js";
import { json, madeUp, on, raw, World } from "./harness.js";
import { SignInDriver } from "./sign-in-driver.js";

// Made-up values only: no real usernames, addresses or tracking numbers.
const AM = "verified.usps.com/am";
const SERVER = `GET ${AM}/json/serverinfo/*`;
const AUTH = `POST ${AM}/json/realms/root/realms/alpha/authenticate`;
const AUTHORIZE = `GET ${AM}/oauth2/authorize`;
const TOKEN = `POST ${AM}/oauth2/access_token`;
const USERINFO = `GET ${AM}/oauth2/userinfo`;
const PACKAGES = "POST apis-id.usps.com/informed-delivery/v3/dashboard/packages/search";
const USER = { username: "made-up-user", password: madeUp("usps") };
const ZIP11 = "00000000001";

const text = (message: string) => ({
  type: "TextOutputCallback",
  output: [
    { name: "message", value: message },
    { name: "messageType", value: "0" },
  ],
});
const round = (...callbacks: unknown[]) => json({ authId: "auth-1", callbacks });
const waiting = round(text("Approve the sign-in on your phone."), {
  type: "PollingWaitCallback",
  output: [{ name: "waitTime", value: "5000" }],
});
const tokens = (tag: string) =>
  json({ access_token: `at-${tag}`, refresh_token: madeUp("rt", tag) });

function signInRoutes() {
  return [
    on(SERVER, json({ realm: "/alpha", cookieName: "made-up-cookie" })),
    on(
      AUTH,
      round(
        {
          type: "NameCallback",
          output: [{ name: "prompt", value: "User Name" }],
          input: [{ name: "IDToken1", value: "" }],
        },
        { type: "PasswordCallback", input: [{ name: "IDToken2", value: "" }] },
        { type: "DeviceProfileCallback", input: [{ name: "IDToken3", value: "" }] },
      ),
      round(text("How should we verify it is you?"), {
        type: "ChoiceCallback",
        output: [
          { name: "prompt", value: "" },
          { name: "choices", value: ["Email", "Text message"] },
        ],
        input: [{ name: "IDToken1", value: 0 }],
      }),
      round(text("Enter the code we sent by text."), {
        type: "OneTimePasswordCallback",
        input: [{ name: "IDToken1", value: "" }],
      }),
      round(text("That code is incorrect. Try again?"), {
        type: "ConfirmationCallback",
        output: [{ name: "options", value: ["Yes", "No"] }],
        input: [{ name: "IDToken2", value: 0 }],
      }),
      waiting,
      waiting.clone(),
      json({ tokenId: "made-up-token-id" }),
    ),
    on(
      AUTHORIZE,
      raw("", 302, { location: "https://informeddelivery.usps.com/portal/callback?code=c-1" }),
    ),
    on(TOKEN, tokens("1")),
    on(
      USERINFO,
      json({
        addresses: [
          { granted_services: ["RMIN"], ZIPCode: "0", ZIPPlus4: "0", deliveryPoint: "1" },
          { granted_services: [], ZIPCode: "11111", ZIPPlus4: "1111", deliveryPoint: "11" },
        ],
      }),
    ),
  ];
}

describe("USPS Informed Delivery sign-in", () => {
  it("walks password, method choice, a refused and a good code, and a phone approval", async () => {
    const world = new World(usps, signInRoutes());
    const driver = new SignInDriver(world, "informed_delivery", "account");
    expect(await driver.start()).toMatchObject({ kind: "form" });

    const choice = await driver.continue(USER);
    expect(choice).toEqual({
      kind: "choose_method",
      options: [
        { id: "0", label: "Email" },
        { id: "1", label: "Text message" },
      ],
      message: "How should we verify it is you?",
    });
    const filled = JSON.parse(world.calls.filter((c) => c.key === AUTH)[1]?.body ?? "{}") as {
      callbacks: { input: { value: unknown }[] }[];
    };
    expect(filled.callbacks.map((cb) => cb.input[0]?.value)).toEqual([
      USER.username,
      USER.password,
      expect.stringContaining('"identifier"'),
    ]);

    expect(await driver.continue({ choice: "1" })).toMatchObject({
      kind: "otp_code",
      channel: "sms",
    });
    const chosen = JSON.parse(world.calls.filter((c) => c.key === AUTH)[2]?.body ?? "{}") as {
      callbacks: { input?: { value: unknown }[] }[];
    };
    expect(chosen.callbacks[1]?.input?.[0]?.value).toBe(1);

    await expect(driver.continue({ code: "000000" })).rejects.toBeInstanceOf(SignInRejectedError);
    // The refused code kept the code step; the next try answers it again.
    expect(driver.step).toMatchObject({ kind: "otp_code" });
    expect(await driver.continue({ code: "123456" })).toEqual({
      kind: "await_approval",
      message: "Approve the sign-in on your phone.",
      pollIntervalSeconds: 5,
      timeoutSeconds: 180,
    });
    expect(await driver.poll()).toMatchObject({ kind: "await_approval" });
    expect(await driver.poll()).toBeNull();
    expect(driver.secret).toEqual({
      informed: { refreshToken: madeUp("rt", "1"), addresses: [ZIP11] },
    });
    expect(world.calls.find((c) => c.key === AUTHORIZE)?.headers.get("cookie")).toBe(
      "made-up-cookie=made-up-token-id",
    );
  });

  it("refuses a bad password outright and treats an outage as transient", async () => {
    const refused = new World(usps, [
      on(SERVER, json({})),
      on(AUTH, round({ type: "PasswordCallback" }), json({ code: 401 }, 401)),
    ]);
    const driver = new SignInDriver(refused, "informed_delivery", "account");
    await driver.start();
    await expect(driver.continue(USER)).rejects.toBeInstanceOf(SignInRejectedError);

    const down = new World(usps, [on(SERVER, raw("<html>busy</html>", 503))]);
    const other = new SignInDriver(down, "informed_delivery", "account");
    await other.start();
    await expect(other.continue(USER)).rejects.toBeInstanceOf(TransientError);
  });

  it("never fills a callback it does not know", async () => {
    const world = new World(usps, [
      on(SERVER, json({})),
      on(AUTH, round({ type: "KbaCreateCallback" })),
    ]);
    const driver = new SignInDriver(world, "informed_delivery", "account");
    await driver.start();
    await expect(driver.continue(USER)).rejects.toBeInstanceOf(TransientError);
  });

  it("keeps only enrolled addresses with a full ZIP11", () => {
    expect(
      enrolledAddresses({
        addresses: [
          { granted_services: ["RMIN"], ZIPCode: "1234", ZIPPlus4: "56", deliveryPoint: "7" },
          { granted_services: ["RMIN"], ZIPCode: "12345" },
        ],
      }),
    ).toEqual(["01234005607"]);
  });
});

describe("USPS Informed Delivery account", () => {
  const SECRET = { informed: { refreshToken: madeUp("rt", "0"), addresses: [ZIP11] } };
  const inbox = json({
    inboundPackages: [
      {
        trackingNumber: "9400100000000000000001",
        shipperName: "Example Shop",
        deliveryInfo: {
          statusCategory: "On the Way",
          status: "In Transit to Next Facility",
          deliveryDate: "2026-11-19",
          text2: "between 1:00pm and 3:00pm",
        },
      },
      {
        trackingNumber: "9400100000000000000002",
        eventTimestamp: "2026-11-18T10:15:00",
        deliveryInfo: { statusCategory: "Delivered", status: "Delivered, Front Door/Porch" },
      },
      { trackingNumber: "9400100000000000000003", deliveryInfo: { statusCategory: "Mystery" } },
    ],
    addedPackages: [],
  });

  it("reads the inbox, renewing an expired session once", async () => {
    const world = new World(usps, [
      on(TOKEN, tokens("a"), tokens("b")),
      on(PACKAGES, json({ code: "TOKEN_EXPIRED" }, 401), inbox),
    ]);
    const result = await world.fetchAccount({ timeZone: "America/Chicago" }, SECRET);
    expect(result.snapshots.map((s) => [s.barcode, s.status])).toEqual([
      ["9400100000000000000001", "in_transit"],
      ["9400100000000000000002", "delivered"],
      ["9400100000000000000003", null],
    ]);
    expect(result.snapshots[0]).toMatchObject({
      plannedFrom: "2026-11-19T19:00:00.000Z",
      plannedTo: "2026-11-19T21:00:00.000Z",
      sender: "Example Shop",
    });
    expect(result.snapshots[1]?.deliveredAt).toBe("2026-11-18T16:15:00.000Z");
    expect(world.unknown).toEqual(["informed_status:Mystery"]);
    const second = world.calls.filter((c) => c.key === PACKAGES)[1];
    expect(second?.headers.get("authorization")).toBe("Bearer at-b");
    expect(JSON.parse(second?.body ?? "{}")).toMatchObject({ ZIP11, deliveryDate: "2026-11-18" });
    expect(world.stored).toMatchObject({ refresh: madeUp("rt", "b") });
  });

  it("asks for a new sign-in only for a dead chain or a revoked session", async () => {
    const dead = new World(usps, [on(TOKEN, json({ error: "invalid_grant" }, 400))]);
    await expect(dead.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    const revoked = new World(usps, [
      on(TOKEN, tokens("a")),
      on(PACKAGES, json({ code: "REVOKED" }, 401)),
    ]);
    await expect(revoked.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    const offline = new World(usps, [on(TOKEN, new TypeError("offline"))]);
    await expect(offline.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(TransientError);
  });

  it("stops on a 200 that is not a JSON object, instead of reading an empty inbox", async () => {
    for (const body of [raw("<html>maintenance</html>", 200), json({ inboundPackages: "x" })]) {
      const world = new World(usps, [on(TOKEN, tokens("a")), on(PACKAGES, body)]);
      await expect(world.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(UnexpectedResponseError);
    }
  });

  it("is not complete after a 204 or a package without a tracking number", async () => {
    const empty = new World(usps, [
      on(TOKEN, tokens("a")),
      on(PACKAGES, new Response(null, { status: 204 })),
    ]);
    expect(await empty.fetchAccount({}, SECRET)).toEqual({ snapshots: [], complete: false });
    const skipped = new World(usps, [
      on(TOKEN, tokens("a")),
      on(PACKAGES, json({ inboundPackages: [{ deliveryInfo: { statusCategory: "Delivered" } }] })),
    ]);
    expect((await skipped.fetchAccount({}, SECRET)).complete).toBe(false);
  });

  it("still tracks with a consumer key, and only with one", async () => {
    const world = new World(usps);
    await expect(world.track(["9400100000000000000001"], {}, SECRET)).rejects.toBeInstanceOf(
      SignInRejectedError,
    );
  });
});
