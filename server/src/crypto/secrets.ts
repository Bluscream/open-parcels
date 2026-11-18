import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Format marker so the layout can change later without guessing. */
const VERSION = 1;

export class SecretKeyError extends Error {
  override readonly name = "SecretKeyError";
}

export class DecryptionError extends Error {
  override readonly name = "DecryptionError";
}

function decodeKey(encoded: string, origin: string): Buffer {
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretKeyError(`${origin} must be ${KEY_BYTES} bytes encoded as base64.`);
  }
  return key;
}

export interface LoadedKey {
  readonly key: Buffer;
  /** True when this call created a new key file, so the caller can log it once. */
  readonly created: boolean;
}

/**
 * Returns the encryption key: from the environment when given, otherwise from
 * `<dataDir>/secret.key`, creating it with mode 0600 on first start. Never invents a throwaway
 * key: losing the key would silently make every stored credential unreadable.
 */
export function loadSecretKey(envValue: string | undefined, dataDir: string): LoadedKey {
  if (envValue !== undefined) {
    return { key: decodeKey(envValue, "OPENPARCELS_SECRET_KEY"), created: false };
  }
  const file = path.join(dataDir, "secret.key");
  if (existsSync(file)) {
    return { key: decodeKey(readFileSync(file, "utf8"), file), created: false };
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  // Some file systems ignore the mode passed to open(); set it explicitly as well.
  chmodSync(file, 0o600);
  return { key, created: true };
}

/**
 * AES-256-GCM with associated data. The associated data binds a ciphertext to its owner (for
 * example `source:<id>:secret`), so a blob copied to another row fails to decrypt instead of
 * leaking into the wrong context.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== KEY_BYTES) {
      throw new SecretKeyError(`The encryption key must be ${KEY_BYTES} bytes.`);
    }
    this.#key = key;
  }

  encrypt(plaintext: string, associatedData: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  decrypt(blob: Buffer, associatedData: string): string {
    if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) {
      throw new DecryptionError("Stored secret has an unknown format.");
    }
    const iv = blob.subarray(1, 1 + IV_BYTES);
    const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const body = blob.subarray(1 + IV_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv);
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    } catch (error) {
      throw new DecryptionError(
        "Stored secret could not be decrypted; the key changed or the data was tampered with.",
        { cause: error },
      );
    }
  }

  /** A separate key for another purpose (signing, for example), derived so the master key never leaves. */
  derive(purpose: string): Buffer {
    return Buffer.from(
      hkdfSync("sha256", this.#key, Buffer.alloc(0), `open-parcels ${purpose}`, KEY_BYTES),
    );
  }

  encryptJson(value: unknown, associatedData: string): Buffer {
    return this.encrypt(JSON.stringify(value), associatedData);
  }

  decryptJson(blob: Buffer, associatedData: string): unknown {
    return JSON.parse(this.decrypt(blob, associatedData));
  }
}
