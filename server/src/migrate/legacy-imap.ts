import { mailConfigSchema, type MailConfig, type MailSecret } from "../mail/types.js";

/** Old credential `service` values that hold a mailbox. */
const MAIL_SERVICES: ReadonlySet<string> = new Set([
  "imap",
  "mail",
  "email",
  "e_mail",
  "mailbox",
  "gmail",
  "outlook",
]);

/** Services whose credentials are deliberately not carried over, with the reason (§3). */
export const DELIBERATELY_SKIPPED: Readonly<Record<string, string>> = {
  amazon:
    "Amazon is signed in again by device registration; its password and TOTP secret are not imported.",
  aliexpress: "AliExpress is signed in again; its stored credentials are not imported.",
};

export function serviceKey(service: string): string {
  return service
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function isMailService(service: string): boolean {
  return MAIL_SERVICES.has(serviceKey(service));
}

type Bag = Record<string, unknown>;

function isBag(value: unknown): value is Bag {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lower-case key without separators, so `imap_host`, `imapHost` and `IMAP-Host` compare equal. */
function flat(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The first non-empty value under any of the names, top level first, then nested objects. */
function pick(bags: readonly Bag[], names: readonly string[]): unknown {
  const wanted = new Set(names.map(flat));
  for (const bag of bags) {
    for (const [key, value] of Object.entries(bag)) {
      // Nested groups are searched as bags of their own, never taken as a value.
      if (wanted.has(flat(key)) && value !== null && value !== "" && !isBag(value)) {
        return value;
      }
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return typeof value === "number" ? String(value) : undefined;
}

function asPort(value: unknown): number | undefined {
  const port = typeof value === "string" ? Number.parseInt(value, 10) : value;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65_536
    ? port
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "ssl", "tls", "implicit"].includes(lowered)) {
      return true;
    }
    if (["false", "0", "no", "off", "none", "plain", "starttls"].includes(lowered)) {
      return false;
    }
  }
  return undefined;
}

function asFolders(value: unknown): string[] | undefined {
  const list = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
  const folders = list
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== undefined)
    .slice(0, 20);
  return folders.length > 0 ? folders : undefined;
}

/** The objects a mailbox's fields may sit in: the record itself and its usual nested groups. */
function bagsOf(record: Bag): Bag[] {
  const bags = [record];
  for (const key of ["imap", "mail", "mailbox", "server", "connection", "auth", "credentials"]) {
    const nested = record[key];
    if (isBag(nested)) {
      bags.push(nested, ...bagsOf(nested).slice(1));
    }
  }
  return bags;
}

export type ImapParse =
  | { readonly ok: true; readonly config: MailConfig; readonly secret: MailSecret }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads one old IMAP credential, whatever its shape. `fallback` holds mailbox settings the old app
 * kept outside the credential (host, port). Reasons name fields only, never their values.
 */
export function parseLegacyImap(record: unknown, fallback: Bag = {}): ImapParse {
  if (!isBag(record)) {
    return { ok: false, reason: "The decrypted credential is not a JSON object." };
  }
  const bags = [...bagsOf(record), fallback];
  const host = asString(pick(bags, ["host", "hostname", "server", "imapHost", "imapServer"]));
  const username = asString(pick(bags, ["user", "username", "login", "email", "account"]));
  const password = asString(pick(bags, ["password", "pass", "passwd", "pwd", "appPassword"]));
  const missing = [
    host === undefined ? "host" : null,
    username === undefined ? "user" : null,
    password === undefined ? "password" : null,
  ].filter((name): name is string => name !== null);
  if (host === undefined || username === undefined || password === undefined) {
    const keys = Object.keys(record).sort().join(", ");
    return {
      ok: false,
      reason: `The IMAP credential has no ${missing.join(", ")} (fields present: ${keys || "none"}).`,
    };
  }
  const port = asPort(pick(bags, ["port", "imapPort"]));
  const secure = asBoolean(pick(bags, ["secure", "tls", "ssl", "useTls", "useSsl", "encryption"]));
  const folders = asFolders(pick(bags, ["folders", "folder", "mailboxes", "boxes", "paths"]));
  const config = mailConfigSchema.safeParse({
    host,
    port: port ?? (secure === false ? 143 : 993),
    secure: secure ?? port !== 143,
    folders: folders ?? ["INBOX"],
    initialDays: 30,
  });
  if (!config.success) {
    return { ok: false, reason: "The IMAP credential's host or folders are not valid." };
  }
  return { ok: true, config: config.data, secret: { username, password } };
}
