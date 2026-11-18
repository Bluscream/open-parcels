/** DHL-specific helpers on top of the carrier harness: made-up ID tokens and a DHL world. */
import { dhl } from "../../src/carriers/dhl/index.js";
import type { FetchResult, PluginHttp } from "../../src/plugin/api.js";
import { World as CarrierWorld, type Call, type Route } from "./harness.js";

export { formOf, json, type Call, type Route } from "./harness.js";

export type Secret = { refreshToken?: string; apiKey?: string } | null;

type Context = Parameters<NonNullable<typeof dhl.track>>[0];

/** A made-up ID token carrying the account claim (or not). */
export function idToken(withAccountClaim = true, tag = "a"): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = withAccountClaim
    ? { sub: `user-${tag}`, post_number: "0000000000" }
    : { sub: "x" };
  return `${encode({ alg: "none" })}.${encode(claims)}.c2ln`;
}

/** The DHL plug-in on the carrier harness, with an empty config and the given secret. */
export class World {
  readonly #world = new CarrierWorld(dhl);

  get routes(): Route[] {
    return this.#world.routes;
  }

  set routes(routes: Route[]) {
    this.#world.routes = routes;
  }

  get http(): PluginHttp {
    return this.#world.base().http;
  }

  get calls(): Call[] {
    return this.#world.calls;
  }

  get unknown(): string[] {
    return this.#world.unknown;
  }

  get clock(): CarrierWorld["clock"] {
    return this.#world.clock;
  }

  get stored(): unknown {
    return this.#world.stored;
  }

  context(secret: Secret): Context {
    return this.#world.context({}, secret);
  }

  /** "METHOD host/path" of every request, in order. */
  hosts(): string[] {
    return this.#world.requests();
  }
}

export function header(call: Call | undefined, name: string): string | null {
  return call?.headers.get(name) ?? null;
}

export function track(context: Context, codes: readonly string[]): Promise<FetchResult> {
  if (dhl.track === undefined) {
    throw new Error("DHL has no tracking source");
  }
  return dhl.track(context, codes);
}

export function fetchAccount(context: Context): Promise<FetchResult> {
  if (dhl.fetchAccount === undefined) {
    throw new Error("DHL has no account source");
  }
  return dhl.fetchAccount(context);
}

export { dhl };
