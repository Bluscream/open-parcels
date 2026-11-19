import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { hashPassword, humanCode, verifyPassword } from "../../src/auth/crypto.js";
import { LoginThrottle } from "../../src/auth/throttle.js";
import { ConfigError, loadConfig } from "../../src/config.js";
import {
  DecryptionError,
  loadSecretKey,
  SecretBox,
  SecretKeyError,
} from "../../src/crypto/secrets.js";
import { migrateToLatest, openDatabase } from "../../src/db/database.js";
import { redactText, redactValue } from "../../src/log/redact.js";
import { FakeClock, OWNER_PASSWORD } from "../helpers.js";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "open-parcels-unit-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("config", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.databasePath.endsWith("openparcels.db")).toBe(true);
    expect(config.secureCookies).toBe(false);
    expect(config.ingressPort).toBeUndefined();
  });

  it("rejects invalid values with a readable message", () => {
    expect(() => loadConfig({ OPENPARCELS_PORT: "99999" })).toThrow(ConfigError);
    expect(() => loadConfig({ OPENPARCELS_LOG_LEVEL: "loud" })).toThrow(/OPENPARCELS_LOG_LEVEL/);
  });

  it("parses boolean flags", () => {
    expect(loadConfig({ OPENPARCELS_SECURE_COOKIES: "yes" }).secureCookies).toBe(true);
  });
});

describe("redaction", () => {
  it("masks emails, coordinates, tracking and order numbers, and bearer tokens", () => {
    const text =
      "user mail jane.doe@example.com at 52.123456,5.654321 parcel 00340434000000000001 order 000-0000000-0000001 Bearer abc.def";
    const result = redactText(text);
    expect(result).not.toContain("jane.doe@example.com");
    expect(result).not.toContain("52.123456");
    expect(result).not.toContain("00340434000000000001");
    expect(result).not.toContain("0000000-0000001");
    expect(result).not.toContain("abc.def");
    expect(result).toContain("0034…");
  });

  it("removes secret keys at any depth and scrubs text values", () => {
    const redacted = "[redacted]";
    const value = redactValue({
      user: { password: OWNER_PASSWORD, note: "mail a@b.de" },
      list: [{ refresh_token: "x" }],
    });
    expect(value).toEqual({
      user: { password: redacted, note: "mail [email]" },
      list: [{ refresh_token: redacted }],
    });
  });

  it("leaves setup codes alone, because they contain no digits", () => {
    const code = humanCode();
    expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}-[A-Z]{4}$/);
    expect(redactText(`code ${code}`)).toBe(`code ${code}`);
  });
});

describe("secrets", () => {
  it("round-trips and binds ciphertext to its associated data", () => {
    const box = new SecretBox(randomBytes(32));
    const blob = box.encryptJson({ user: "a", password: "b" }, "source:1:secret");
    expect(box.decryptJson(blob, "source:1:secret")).toEqual({ user: "a", password: "b" });
    expect(() => box.decrypt(blob, "source:2:secret")).toThrow(DecryptionError);
  });

  it("fails loudly with another key instead of returning garbage", () => {
    const blob = new SecretBox(randomBytes(32)).encrypt("value", "ad");
    expect(() => new SecretBox(randomBytes(32)).decrypt(blob, "ad")).toThrow(DecryptionError);
  });

  it("detects tampering", () => {
    const box = new SecretBox(randomBytes(32));
    const blob = box.encrypt("value", "ad");
    blob[blob.length - 1] = (blob.at(-1) ?? 0) ^ 0xff;
    expect(() => box.decrypt(blob, "ad")).toThrow(DecryptionError);
  });

  it("creates a key file once and reuses it", () => {
    const dir = tempDir();
    const first = loadSecretKey(undefined, dir);
    const second = loadSecretKey(undefined, dir);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
    expect(readFileSync(path.join(dir, "secret.key"), "utf8").trim()).toBe(
      first.key.toString("base64"),
    );
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, "secret.key")).mode & 0o777).toBe(0o600);
    }
  });

  it("prefers the environment key and validates its length", () => {
    const key = randomBytes(32);
    expect(loadSecretKey(key.toString("base64"), tempDir()).key.equals(key)).toBe(true);
    expect(() => loadSecretKey(randomBytes(16).toString("base64"), tempDir())).toThrow(
      SecretKeyError,
    );
  });
});

describe("passwords", () => {
  it("verifies the right password only", async () => {
    const hash = await hashPassword("a long enough password");
    expect(hash.startsWith("scrypt$")).toBe(true);
    await expect(verifyPassword("a long enough password", hash)).resolves.toBe(true);
    await expect(verifyPassword("a long enough passworD", hash)).resolves.toBe(false);
    await expect(verifyPassword("anything", "not-a-hash")).resolves.toBe(false);
  });
});

describe("login throttle", () => {
  it("blocks after five failures and recovers after the window", () => {
    const clock = new FakeClock();
    const throttle = new LoginThrottle(clock);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(throttle.retryAfterSeconds("ip")).toBe(0);
      throttle.recordFailure("ip");
    }
    expect(throttle.retryAfterSeconds("ip")).toBeGreaterThan(0);
    expect(throttle.retryAfterSeconds("other")).toBe(0);
    clock.advance(15 * 60 * 1000 + 1);
    expect(throttle.retryAfterSeconds("ip")).toBe(0);
  });
});

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    const { db } = openDatabase(path.join(tempDir(), "db.sqlite"));
    try {
      expect(await migrateToLatest(db)).toEqual([
        "0001-initial",
        "0002-reconciler",
        "0003-sign-in-attempts",
        "0004-lookup-state",
        "0005-archive-reason",
        "0006-auto-created-sources",
      ]);
      expect(await migrateToLatest(db)).toEqual([]);
    } finally {
      // Windows cannot delete an open database file; close it even when an assertion fails.
      await db.destroy();
    }
  });
});
