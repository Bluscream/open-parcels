import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { safeEqual } from "../auth/crypto.js";
import { SCOPES, type AuthStore, type Scope } from "../auth/store.js";
import { forbidden, unauthorized, ApiError } from "./errors.js";

export const SESSION_COOKIE = "op_session";
export const CSRF_HEADER = "x-csrf-token";

/** Address the Home Assistant Supervisor uses for ingress requests. */
export const HA_INGRESS_ADDRESS = "172.30.32.2";

export type AuthContext =
  | { readonly kind: "ingress"; readonly scopes: readonly Scope[] }
  | { readonly kind: "token"; readonly tokenId: string; readonly scopes: readonly Scope[] }
  | { readonly kind: "session"; readonly csrfToken: string; readonly scopes: readonly Scope[] };

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AuthPluginOptions {
  readonly store: AuthStore;
  /**
   * When set, this server instance is the Home Assistant ingress listener and requests from this
   * address are trusted as the owner: Home Assistant has already authenticated the user.
   */
  readonly trustedIngressAddress: string | undefined;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match?.[1];
}

async function resolveAuth(
  request: FastifyRequest,
  options: AuthPluginOptions,
): Promise<AuthContext | null> {
  if (options.trustedIngressAddress !== undefined) {
    // On the ingress listener nothing else is accepted: only the Supervisor may talk to it.
    return request.socket.remoteAddress === options.trustedIngressAddress
      ? { kind: "ingress", scopes: SCOPES }
      : null;
  }
  const token = bearerToken(request);
  if (token !== undefined) {
    const found = await options.store.findToken(token);
    return found === undefined ? null : { kind: "token", tokenId: found.id, scopes: found.scopes };
  }
  const cookie = request.cookies[SESSION_COOKIE];
  if (cookie === undefined) {
    return null;
  }
  const session = await options.store.findSession(cookie);
  return session === undefined
    ? null
    : { kind: "session", csrfToken: session.csrfToken, scopes: SCOPES };
}

/** Browser sessions must echo the CSRF token on state-changing requests. */
function checkCsrf(request: FastifyRequest, auth: AuthContext): void {
  if (auth.kind !== "session" || SAFE_METHODS.has(request.method)) {
    return;
  }
  const sent = request.headers[CSRF_HEADER];
  if (typeof sent !== "string" || !safeEqual(sent, auth.csrfToken)) {
    throw new ApiError(
      403,
      "csrf",
      "The CSRF token is missing or wrong. Reload the page and try again.",
    );
  }
}

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): void {
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = await resolveAuth(request, options);
    if (request.auth !== null) {
      checkCsrf(request, request.auth);
    }
  });
}

/** Route guard: the request must be authenticated and hold the scope. */
export function requireScope(scope: Scope): preHandlerHookHandler {
  return (request: FastifyRequest, _reply: FastifyReply, done) => {
    if (request.auth === null) {
      done(unauthorized());
      return;
    }
    if (!request.auth.scopes.includes(scope)) {
      done(forbidden(scope));
      return;
    }
    done();
  };
}
