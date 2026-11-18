import { z } from "zod";
import type { PluginHttp } from "../../plugin/http.js";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type PluginLogger,
  type SessionStore,
} from "../../plugin/api.js";
import { ACCOUNT_HOST, isObject, type Json } from "./shared.js";

const BASE = `https://${ACCOUNT_HOST}/api/v12/`;
/**
 * The mobile app's public client key. It identifies the app, not the user; a rotated key shows
 * up as an HTML refusal from the gateway and is treated as a transient failure, never as a
 * reason to sign in again.
 */
const APP_KEY = "acefe97f-89fc-4f4e-9543-fc6b90f68928";

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

const tokensSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().min(1) });
export type Tokens = z.infer<typeof tokensSchema>;

/** The carrier explicitly refused a token or the credentials (JSON 401/403). */
class Refused extends Error {
  override readonly name = "Refused";
}

function isHtml(response: HttpResponse): boolean {
  const type = response.headers.get("content-type") ?? "";
  return type.toLowerCase().includes("html") || response.body.trimStart().startsWith("<");
}

function parseJson(response: HttpResponse, what: string): unknown {
  try {
    return response.json();
  } catch {
    throw new UnexpectedResponseError(`Hermes ${what} did not answer with JSON.`);
  }
}

export class HermesAccount {
  constructor(
    private readonly http: PluginHttp,
    private readonly logger: PluginLogger,
  ) {}

  async #call(path: string, options: { body?: Json; token?: string }): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      "api-key": APP_KEY,
      accept: "application/json",
      "accept-language": "de-de",
    };
    if (options.token !== undefined) {
      headers["authorization"] = `Bearer ${options.token}`;
    }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await this.http.request(new URL(path, BASE), {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (response.status === 401 || response.status === 403) {
      // The gateway answers a refused app key with a small HTML page before it looks at the
      // user at all; that is not the user's problem and must never lead to a new sign-in.
      if (isHtml(response)) {
        this.logger.warn({ path, status: response.status }, "Hermes gateway refused the app.");
        throw new TransientError(`Hermes refused ${path} before checking the sign-in.`);
      }
      throw new Refused(path);
    }
    if (response.status !== 200) {
      throw new TransientError(`Hermes ${path} answered HTTP ${response.status}.`);
    }
    return response;
  }

  async #tokens(path: string, body: Json): Promise<Tokens> {
    const parsed = tokensSchema.safeParse(parseJson(await this.#call(path, { body }), path));
    if (!parsed.success) {
      throw new UnexpectedResponseError(`Hermes ${path} returned no tokens.`);
    }
    return parsed.data;
  }

  login(credentials: Credentials): Promise<Tokens> {
    return this.#tokens("users/login", {
      username: credentials.username,
      password: credentials.password,
    });
  }

  refresh(tokens: Tokens): Promise<Tokens> {
    return this.#tokens("users/refreshtoken", { refreshToken: tokens.refreshToken });
  }

  async shipments(tokens: Tokens): Promise<Json[]> {
    const payload = parseJson(
      await this.#call("shipments", { token: tokens.accessToken }),
      "shipments",
    );
    if (!Array.isArray(payload)) {
      throw new UnexpectedResponseError("Hermes shipments is not a list.");
    }
    return payload.filter(isObject);
  }
}

async function signIn(client: HermesAccount, credentials: Credentials): Promise<Tokens> {
  try {
    return await client.login(credentials);
  } catch (error) {
    if (error instanceof Refused) {
      throw new SignInRejectedError("Hermes refused the username or password.");
    }
    throw error;
  }
}

/** A refused refresh token falls back to one sign-in with the stored credentials. */
async function renew(client: HermesAccount, tokens: Tokens, credentials: Credentials) {
  try {
    return await client.refresh(tokens);
  } catch (error) {
    if (error instanceof Refused) {
      return signIn(client, credentials);
    }
    throw error;
  }
}

/**
 * Reads the account inbox. Tokens live in the session store. Only an explicit refusal renews
 * them, once per run; network errors, timeouts and gateway pages propagate untouched.
 */
export async function readInbox(
  client: HermesAccount,
  session: SessionStore,
  credentials: Credentials,
): Promise<Json[]> {
  const stored = tokensSchema.safeParse(session.load());
  let tokens: Tokens;
  let fresh = false;
  if (stored.success) {
    tokens = stored.data;
  } else {
    tokens = await signIn(client, credentials);
    fresh = true;
    await session.save(tokens);
  }
  try {
    return await client.shipments(tokens);
  } catch (error) {
    if (!(error instanceof Refused)) {
      throw error;
    }
    if (fresh) {
      throw new SignInRejectedError("Hermes refused a token it had just issued.");
    }
  }
  tokens = await renew(client, tokens, credentials);
  await session.save(tokens);
  try {
    return await client.shipments(tokens);
  } catch (error) {
    if (error instanceof Refused) {
      throw new SignInRejectedError("Hermes refused the renewed sign-in.");
    }
    throw error;
  }
}
