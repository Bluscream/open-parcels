import { constants, generateKeyPairSync, publicEncrypt, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { proof, type Device } from "../../src/carriers/posti/device.js";
import { posti } from "../../src/carriers/posti/index.js";
import { SignInRejectedError, TransientError } from "../../src/plugin/api.js";
import { FakeClock } from "../helpers.js";
import { html, json, on, raw, World, type Call } from "./harness.js";
import { SignInDriver } from "./sign-in-driver.js";

// Made-up values only: no real accounts, banks' requests or shipment ids.
const AUTH = "auth-service.posti.fi/api/v1";
const MFA = "mfa.posti.fi/api/v1";
const UAS = "todentaminen.posti.fi";
const GRAPHQL = "POST graphql.posti.fi/graphql";
const NOW_S = Math.floor(new FakeClock().now().getTime() / 1000);

const jwt = (claims: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2ln"].join(".");
const ID_TOKEN = jwt({ sub: "subject-1", exp: NOW_S + 3600 });
const STALE = jwt({ sub: "subject-1", exp: NOW_S - 10 });
const ROLES = [{ type: "consumer", token: "role-1" }];
const PSS = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };

function signed(publicKey: string, message: string, signature: unknown): boolean {
  return verify(
    "sha256",
    Buffer.from(message),
    { key: publicKey, ...PSS },
    Buffer.from(String(signature), "base64"),
  );
}

const bodyOf = (call: Call | undefined): Record<string, unknown> =>
  JSON.parse(call?.body ?? "{}") as Record<string, unknown>;

function loginRoutes(captured: { publicKey?: string }) {
  return [
    on(`POST ${AUTH}/device_login`, json({ login_url: `https://${UAS}/uas/authn/start` })),
    on(
      `GET ${UAS}/uas/authn/start`,
      html(
        '<a href="/uas/authn/x/select?method=nordea&amp;s=1">Nordea</a>' +
          '<a href="/uas/authn/x/select?method=mobileid&amp;s=1">Mobiilivarmenne</a>',
        200,
        { "set-cookie": "uas=session-1; Path=/; Secure" },
      ),
    ),
    on(
      `GET ${UAS}/uas/authn/x/select`,
      html(
        '<form action="https://tunnistus.telia.fi/uas/saml2/names?x=1" method="post">' +
          '<input type="hidden" name="request" value="REQ+1"></form>',
      ),
    ),
    on(
      `GET ${UAS}/uas/return/abc`,
      html('<input name="code" value="c-2"><input name="state" value="s-2">'),
    ),
    on(
      `GET ${AUTH}/device_oidc_callback`,
      raw("", 302, { location: "https://oma.posti.fi/app/login?code=auth-3" }),
    ),
    on(`POST ${AUTH}/token_v2`, json({ id_token: ID_TOKEN, refresh_token: "rt+1/=" })),
    on(
      `POST ${MFA}/provisionings/initiate`,
      json({ transaction_id: "tx-1", finalization_code: "fin-1" }),
    ),
    (call: Call) => {
      if (call.key !== `POST ${MFA}/provisionings`) {
        return undefined;
      }
      const body = bodyOf(call);
      captured.publicKey = String(body["public_key"]);
      const ok = signed(
        captured.publicKey,
        `${String(body["authorization_secret"])}tx-1`,
        body["signature"],
      );
      return ok ? json({ device_id: "dev-1" }, 201) : json({ error: "bad signature" }, 400);
    },
    (call: Call) => {
      if (call.key !== `POST ${MFA}/device_trust_token`) {
        return undefined;
      }
      const body = bodyOf(call);
      const ok = signed(
        captured.publicKey ?? "",
        `device|dev-1|${String(body["timestamp"])}`,
        body["device_sig"],
      );
      return ok ? json({ token: "trust+1/=" }) : json({ error: "bad proof" }, 403);
    },
    on(`POST ${AUTH}/device_refresh`, json({ id_token: ID_TOKEN, role_tokens: ROLES })),
  ];
}

describe("Posti sign-in", () => {
  it("chooses a method, hands over the bank address and registers a device", async () => {
    const captured: { publicKey?: string } = {};
    const world = new World(posti, loginRoutes(captured));
    const driver = new SignInDriver(world, "bank_id", "account");
    expect(await driver.start()).toMatchObject({
      kind: "choose_method",
      options: [
        { id: "mobileid", label: "Mobiilivarmenne (mobile ID)" },
        { id: "nordea", label: "Nordea" },
      ],
    });
    await expect(driver.continue({ choice: "pigeon" })).rejects.toBeInstanceOf(SignInRejectedError);
    expect(await driver.continue({ choice: "nordea" })).toMatchObject({
      kind: "open_url",
      url: "https://tunnistus.telia.fi/uas/saml2/names?x=1&request=REQ%2B1",
    });
    await expect(
      driver.continue({ pasted: "https://evil.example.invalid/uas/return/abc?code=1" }),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    expect(await driver.continue({ pasted: `https://${UAS}/uas/return/abc?code=xyz` })).toBeNull();

    const secret = driver.secret as { device: Device; idToken: string; roleTokens: unknown };
    expect(secret).toMatchObject({
      device: { deviceId: "dev-1", subject: "subject-1" },
      idToken: ID_TOKEN,
      roleTokens: ROLES,
    });
    expect(secret.device.privateKey).toContain("PRIVATE KEY");
    // The login's cookie session carried from the method page to the return address.
    expect(
      world.calls.find((c) => c.key === `GET ${UAS}/uas/return/abc`)?.headers.get("cookie"),
    ).toBe("uas=session-1");
    // The renewal form goes out exactly as Posti handed the keys over, never percent-encoded.
    expect(world.calls.find((c) => c.key === `POST ${AUTH}/device_refresh`)?.body).toBe(
      `refresh_token=rt+1/=&device_trust_token=trust+1/=&id_token=${ID_TOKEN}`,
    );
    expect(
      world.calls
        .find((c) => c.key === `GET ${UAS}/uas/authn/start`)
        ?.headers.get("x-requested-with"),
    ).toBe("fi.itella.posti.android");
  });

  it("treats an unreachable login as transient", async () => {
    const world = new World(posti, [on(`POST ${AUTH}/device_login`, new TypeError("offline"))]);
    await expect(new SignInDriver(world, "bank_id", "account").start()).rejects.toBeInstanceOf(
      TransientError,
    );
  });
});

describe("Posti device", () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const device: Device = {
    deviceId: "dev-9",
    privateKey,
    salt: Buffer.alloc(32, 7).toString("base64"),
    subject: "subject-1",
  };
  const SECRET = { device, idToken: STALE, roleTokens: ROLES };
  const VAULT_KEY = "k".repeat(43) + "=";
  const vault = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(VAULT_KEY),
  ).toString("base64");

  it("never signs two requests with the same time", () => {
    const clock = new FakeClock();
    const first = proof(device, clock);
    const second = proof(device, clock);
    expect(second["timestamp"]).toBe(Number(first["timestamp"]) + 1);
    expect(
      signed(publicKey, `device|dev-9|${String(first["timestamp"])}`, first["device_sig"]),
    ).toBe(true);
  });

  it("renews an expiring token through the vault and lists both directions", async () => {
    const world = new World(posti, [
      on(`POST ${MFA}/device_refresh`, json({ device_trust_token: "t-1", vault_data: vault })),
      on(`POST ${AUTH}/device_refresh`, json({ id_token: ID_TOKEN, role_tokens: [] })),
      on(
        GRAPHQL,
        json({
          data: {
            consumerShipments: {
              totalPages: 1,
              hits: [
                {
                  displayId: "JJFI00000000000001",
                  userRole: "RECEIVER",
                  displayName: "Example Shop",
                  status: { main: "DELIVERED" },
                  events: [],
                },
                { shipmentId: "S-2", userRole: "SENDER", displayName: "A Friend", events: [] },
              ],
            },
          },
        }),
      ),
    ]);
    const result = await world.fetchAccount({}, SECRET);
    expect(
      result.snapshots.map((s) => [s.barcode, s.direction, s.status, s.sender, s.receiver]),
    ).toEqual([
      ["JJFI00000000000001", "incoming", "delivered", "Example Shop", null],
      ["S-2", "outgoing", null, null, "A Friend"],
    ]);
    expect(world.calls.find((c) => c.key === `POST ${AUTH}/device_refresh`)?.body).toBe(
      `refresh_token=${VAULT_KEY}&device_trust_token=t-1`,
    );
    expect(world.calls.find((c) => c.key === GRAPHQL)?.headers.get("authorization")).toBe("role-1");
    expect(world.stored).toEqual({ device: "dev-9", idToken: ID_TOKEN, roleTokens: ROLES });
  });

  it("asks for a new login only when Posti dropped the device", async () => {
    const dropped = new World(posti, [
      on(
        `POST ${MFA}/device_refresh`,
        json({ error: { code: 404, message: "INACTIVE_DEVICE" } }, 404),
      ),
    ]);
    await expect(dropped.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(SignInRejectedError);
    const moved = new World(posti, [
      on(`POST ${MFA}/device_refresh`, json({ error: "not here" }, 404)),
    ]);
    await expect(moved.fetchAccount({}, SECRET)).rejects.toBeInstanceOf(TransientError);
  });

  it("renews once after a refusal, then gives up", async () => {
    const unauthorized = json({ errors: [{ errorType: "Unauthorized" }] });
    const world = new World(posti, [
      on(GRAPHQL, unauthorized, unauthorized.clone()),
      on(`POST ${MFA}/device_refresh`, json({ device_trust_token: "t-1", vault_data: vault })),
      on(`POST ${AUTH}/device_refresh`, json({ id_token: ID_TOKEN, role_tokens: ROLES })),
    ]);
    await expect(
      world.fetchAccount({}, { ...SECRET, idToken: ID_TOKEN, roleTokens: ROLES }),
    ).rejects.toBeInstanceOf(SignInRejectedError);
    expect(world.requests().filter((key) => key === GRAPHQL)).toHaveLength(2);
  });
});
