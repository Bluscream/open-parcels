import type { Kysely } from "kysely";
import { addMs, isoNow, type Clock } from "../clock.js";
import type { Database } from "../db/schema.js";
import { hashPassword, randomSecret, sha256Hex, verifyPassword } from "./crypto.js";

export const SCOPES = ["read", "write", "admin"] as const;
export type Scope = (typeof SCOPES)[number];

/** `admin` may change anything; `reader` may only read. */
export const ROLES = ["reader", "admin"] as const;
export type Role = (typeof ROLES)[number];

/** What each role may do, as API-token scopes, so routes check one thing for every caller. */
export const ROLE_SCOPES: Readonly<Record<Role, readonly Scope[]>> = {
  reader: ["read"],
  admin: SCOPES,
};

/** A token that may write or administer counts as admin; a read-only one as reader. */
export function roleOfScopes(scopes: readonly Scope[]): Role {
  return scopes.includes("write") || scopes.includes("admin") ? "admin" : "reader";
}

function parseRole(value: string): Role {
  // Anything unexpected is the lesser role.
  return value === "admin" ? "admin" : "reader";
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is only written back once per hour to avoid a write on every request. */
const SESSION_TOUCH_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = "opk_";

export interface SessionInfo {
  readonly csrfToken: string;
  readonly role: Role;
  readonly expiresAt: string;
}

export interface CreatedSession extends SessionInfo {
  /** Raw cookie value. Only the hash is stored. */
  readonly cookieValue: string;
}

export interface TokenInfo {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly Scope[];
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
}

function parseScopes(json: string): Scope[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((value): value is Scope => SCOPES.includes(value as Scope));
}

/** Persistence for the single owner, browser sessions and API tokens. */
export class AuthStore {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly clock: Clock,
  ) {}

  async hasOwner(): Promise<boolean> {
    const row = await this.db.selectFrom("owner").select("id").executeTakeFirst();
    return row !== undefined;
  }

  async setOwnerPassword(password: string): Promise<void> {
    const now = isoNow(this.clock);
    const passwordHash = await hashPassword(password);
    await this.db
      .insertInto("owner")
      .values({ id: 1, password_hash: passwordHash, created_at: now, updated_at: now })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({ password_hash: passwordHash, updated_at: now }),
      )
      .execute();
  }

  /** False when no admin password was ever saved here (the environment's then applies). */
  async verifyOwnerPassword(password: string): Promise<boolean> {
    const row = await this.db.selectFrom("owner").select("password_hash").executeTakeFirst();
    return row !== undefined && (await verifyPassword(password, row.password_hash));
  }

  /** Forgets the saved admin password, so the environment's applies again. */
  async clearOwnerPassword(): Promise<void> {
    await this.db.deleteFrom("owner").execute();
  }

  async createSession(userAgent: string | null, role: Role): Promise<CreatedSession> {
    const now = this.clock.now();
    const cookieValue = randomSecret();
    const csrfToken = randomSecret(24);
    const expiresAt = addMs(now, SESSION_TTL_MS).toISOString();
    await this.db
      .insertInto("sessions")
      .values({
        id_hash: sha256Hex(cookieValue),
        csrf_token: csrfToken,
        created_at: now.toISOString(),
        expires_at: expiresAt,
        last_seen_at: now.toISOString(),
        user_agent: userAgent?.slice(0, 200) ?? null,
        role,
      })
      .execute();
    return { cookieValue, csrfToken, role, expiresAt };
  }

  /** Returns the session for a cookie value, extending its expiry; undefined when unknown or expired. */
  async findSession(cookieValue: string): Promise<SessionInfo | undefined> {
    const now = this.clock.now();
    const idHash = sha256Hex(cookieValue);
    const row = await this.db
      .selectFrom("sessions")
      .select(["csrf_token", "expires_at", "last_seen_at", "role"])
      .where("id_hash", "=", idHash)
      .executeTakeFirst();
    if (row === undefined || Date.parse(row.expires_at) <= now.getTime()) {
      return undefined;
    }
    const role = parseRole(row.role);
    if (now.getTime() - Date.parse(row.last_seen_at) < SESSION_TOUCH_MS) {
      return { csrfToken: row.csrf_token, role, expiresAt: row.expires_at };
    }
    const expiresAt = addMs(now, SESSION_TTL_MS).toISOString();
    await this.db
      .updateTable("sessions")
      .set({ last_seen_at: now.toISOString(), expires_at: expiresAt })
      .where("id_hash", "=", idHash)
      .execute();
    return { csrfToken: row.csrf_token, role, expiresAt };
  }

  /** Whether a session is still signed in, without extending it (an open stream is not use). */
  async sessionAlive(cookieValue: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("sessions")
      .select("expires_at")
      .where("id_hash", "=", sha256Hex(cookieValue))
      .executeTakeFirst();
    return row !== undefined && Date.parse(row.expires_at) > this.clock.now().getTime();
  }

  async deleteSession(cookieValue: string): Promise<void> {
    await this.db.deleteFrom("sessions").where("id_hash", "=", sha256Hex(cookieValue)).execute();
  }

  async deleteAllSessions(): Promise<void> {
    await this.db.deleteFrom("sessions").execute();
  }

  async deleteSessionsWithRole(role: Role): Promise<void> {
    await this.db.deleteFrom("sessions").where("role", "=", role).execute();
  }

  async pruneExpiredSessions(): Promise<number> {
    const result = await this.db
      .deleteFrom("sessions")
      .where("expires_at", "<=", isoNow(this.clock))
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  async createToken(
    name: string,
    scopes: readonly Scope[],
    expiresAt: string | null,
  ): Promise<{ token: string; info: TokenInfo }> {
    const now = isoNow(this.clock);
    const token = `${TOKEN_PREFIX}${randomSecret()}`;
    const id = crypto.randomUUID();
    await this.db
      .insertInto("api_tokens")
      .values({
        id,
        name,
        token_hash: sha256Hex(token),
        scopes: JSON.stringify(scopes),
        created_at: now,
        last_used_at: null,
        expires_at: expiresAt,
      })
      .execute();
    return {
      token,
      info: { id, name, scopes: [...scopes], createdAt: now, lastUsedAt: null, expiresAt },
    };
  }

  /** Resolves a bearer token to its scopes; undefined when unknown or expired. */
  async findToken(token: string): Promise<{ id: string; scopes: Scope[] } | undefined> {
    if (!token.startsWith(TOKEN_PREFIX)) {
      return undefined;
    }
    const now = isoNow(this.clock);
    const row = await this.db
      .selectFrom("api_tokens")
      .select(["id", "scopes", "expires_at", "last_used_at"])
      .where("token_hash", "=", sha256Hex(token))
      .executeTakeFirst();
    if (row === undefined || (row.expires_at !== null && row.expires_at <= now)) {
      return undefined;
    }
    await this.db
      .updateTable("api_tokens")
      .set({ last_used_at: now })
      .where("id", "=", row.id)
      .execute();
    return { id: row.id, scopes: parseScopes(row.scopes) };
  }

  async listTokens(): Promise<TokenInfo[]> {
    const rows = await this.db.selectFrom("api_tokens").selectAll().orderBy("created_at").execute();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      scopes: parseScopes(row.scopes),
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    }));
  }

  async deleteToken(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom("api_tokens").where("id", "=", id).executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
