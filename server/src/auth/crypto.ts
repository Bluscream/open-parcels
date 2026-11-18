import { createHash, randomBytes, randomInt, scrypt, timingSafeEqual } from "node:crypto";

/** scrypt parameters: N=2^15, r=8, p=1 (~32 MiB, ~100 ms) – OWASP's minimum is N=2^17 with r=8 p=1
 * for interactive logins on servers; this app runs on Raspberry Pis, so N=2^15 is the trade-off. */
const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

function deriveKey(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 128 * n * r * 2 }, (error, key) => {
      if (error === null) {
        resolve(key);
      } else {
        reject(error);
      }
    });
  });
}

/** Returns `scrypt$N$r$p$salt$hash` with base64url salt and hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (
    scheme !== "scrypt" ||
    n === undefined ||
    r === undefined ||
    p === undefined ||
    salt === undefined ||
    hash === undefined
  ) {
    return false;
  }
  const expected = Buffer.from(hash, "base64url");
  const actual = await deriveKey(
    password,
    Buffer.from(salt, "base64url"),
    Number(n),
    Number(r),
    Number(p),
  );
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A random URL-safe secret, e.g. for session cookies and API tokens. */
export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Constant-time comparison of two strings. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * A setup code people can type from a log line: letters only (no digits, so log redaction never
 * masks it) and no easily confused letters, in groups of four.
 */
export function humanCode(groups = 3): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const parts: string[] = [];
  for (let group = 0; group < groups; group += 1) {
    let part = "";
    for (let index = 0; index < 4; index += 1) {
      part += alphabet.charAt(randomInt(alphabet.length));
    }
    parts.push(part);
  }
  return parts.join("-");
}
