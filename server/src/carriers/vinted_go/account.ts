import { createHash } from "node:crypto";
import {
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  asObject,
  isObject,
  objects,
  readJson,
  snapshot,
  text,
  type FetchResult,
  type InteractiveSignIn,
  type Json,
  type ParcelSnapshot,
  type PluginContext,
  type PluginHttp,
} from "../../plugin/api.js";

export const MEMBERS = "https://carrier.vintedgo.com/members";

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "session" | "reportUnknown">;

/** The parts of the tracking source the account reuses, passed in to keep the modules acyclic. */
export interface Timeline {
  lookUp(http: PluginHttp, code: string): Promise<Json[] | null>;
  toSnapshot(
    events: readonly Json[],
    code: string,
    report: (group: string) => void,
  ): ParcelSnapshot;
}

/** The token in a pasted verification link, or the pasted token itself. */
export function verificationToken(pasted: string): string {
  const value = pasted.trim();
  const match = /[?&]token=([^&\s#]+)/.exec(value);
  return match?.[1] === undefined ? value : decodeURIComponent(match[1]);
}

function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

async function post(http: PluginHttp, path: string, body: Json) {
  return http.request(new URL(`${MEMBERS}/${path}`), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

function tokenPair(payload: unknown): { session: string; refresh: string } {
  const session = isObject(payload) ? text(payload["session_token"]) : null;
  const refresh = isObject(payload) ? text(payload["refresh_token"]) : null;
  if (session === null || refresh === null) {
    throw new UnexpectedResponseError("Vinted Go answered without a token pair.");
  }
  return { session, refresh };
}

/** Passwordless sign-in: Vinted Go emails a link; the user pastes it (or its token) back. */
export function emailSignIn<Config>(): InteractiveSignIn<
  Config,
  { readonly refreshToken: string }
> {
  return {
    type: "interactive",
    id: "email_link",
    label: "Vinted Go account (emailed sign-in link)",
    kinds: ["account"],
    start: () =>
      Promise.resolve({
        step: {
          kind: "form",
          fields: [{ name: "email", label: "Email", type: "email" }],
          message: "The email address of your Vinted Go account. Vinted Go sends a link to it.",
        },
        state: null,
      }),
    async continue(context, state, input) {
      if (state === null) {
        const email = (input["email"] ?? "").trim();
        const response = await post(context.http, "registrations", { email });
        if (response.status !== 200) {
          throw new TransientError(`Vinted Go's sign-in answered HTTP ${response.status}.`);
        }
        return {
          step: { kind: "email_link", destination: maskEmail(email) },
          state: { sent: true },
        };
      }
      const response = await post(context.http, "registrations/confirm", {
        token: verificationToken(input["code"] ?? ""),
      });
      if ([400, 401, 404, 422].includes(response.status)) {
        throw new SignInRejectedError("Vinted Go refused the link; it may have expired.");
      }
      if (response.status !== 200) {
        throw new TransientError(`Vinted Go's confirmation answered HTTP ${response.status}.`);
      }
      return { secret: { refreshToken: tokenPair(readJson(response, "Vinted Go")).refresh } };
    },
  };
}

interface Stored {
  readonly base: string;
  readonly refresh: string;
  readonly session: string | null;
}

const fingerprint = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

/**
 * The session of one account. The refresh token rotates; the newest one is saved before it is
 * used, and `base` ties the stored chain to the token the user signed in with.
 */
class Session {
  #stored: Stored;

  constructor(
    private readonly deps: Deps,
    signedInWith: string,
  ) {
    const saved = asObject(deps.session.load());
    const base = fingerprint(signedInWith);
    const refresh = text(saved["refresh"]);
    this.#stored =
      saved["base"] === base && refresh !== null
        ? { base, refresh, session: text(saved["session"]) }
        : { base, refresh: signedInWith, session: null };
  }

  async token(): Promise<string> {
    return this.#stored.session ?? this.refresh();
  }

  /** Mints a new session token. Only an outright refusal is a sign-in problem. */
  async refresh(): Promise<string> {
    const response = await post(this.deps.http, "sessions/refresh", {
      refresh_token: this.#stored.refresh,
    });
    if ([400, 401, 403, 404, 422].includes(response.status)) {
      throw new SignInRejectedError("Vinted Go no longer accepts the sign-in.");
    }
    if (response.status !== 200) {
      throw new TransientError(`Vinted Go's session refresh answered HTTP ${response.status}.`);
    }
    const pair = tokenPair(readJson(response, "Vinted Go"));
    this.#stored = { ...this.#stored, refresh: pair.refresh, session: pair.session };
    await this.deps.session.save(this.#stored);
    return pair.session;
  }
}

async function shipments(deps: Deps, session: Session): Promise<Json[]> {
  for (const retry of [false, true]) {
    const token = retry ? await session.refresh() : await session.token();
    const response = await deps.http.request(new URL(`${MEMBERS}/shipments`), {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
    if (response.status === 401 && !retry) {
      continue;
    }
    if (response.status === 401) {
      throw new SignInRejectedError("Vinted Go refused a fresh session.");
    }
    if (response.status !== 200) {
      throw new TransientError(`Vinted Go's shipments answered HTTP ${response.status}.`);
    }
    const payload = readJson(response, "Vinted Go");
    if (!Array.isArray(payload)) {
      throw new UnexpectedResponseError("Vinted Go's shipments are not a list.");
    }
    return objects(payload);
  }
  return [];
}

const DIRECTION: Readonly<Record<string, "incoming" | "outgoing">> = {
  recipient: "incoming",
  sender: "outgoing",
};

/** Everything the account lists, sent and received. Finished shipments skip the timeline call. */
export async function fetchVintedAccount(
  deps: Deps,
  refreshToken: string,
  timeline: Timeline,
): Promise<FetchResult> {
  const session = new Session(deps, refreshToken);
  const snapshots: ParcelSnapshot[] = [];
  const report = (group: string): void => {
    deps.reportUnknown("group", group);
  };
  for (const shipment of await shipments(deps, session)) {
    const code = text(shipment["tracking_code"]);
    const contact = text(shipment["contact_type"]) ?? "";
    const direction = DIRECTION[contact];
    if (code === null || direction === undefined) {
      if (code !== null) {
        deps.reportUnknown("contact_type", contact);
      }
      continue;
    }
    const finished = text(shipment["status_group"]) === "completed";
    const events = finished ? null : await timeline.lookUp(deps.http, code);
    const base =
      events === null
        ? snapshot({
            carrier: "vinted_go",
            barcode: code,
            status: text(shipment["resolution"]) === "delivered" ? "delivered" : null,
            rawStatus: text(shipment["shipment_state"]),
            url: `https://vintedgo.com/en/tracking/${encodeURIComponent(code)}`,
          })
        : timeline.toSnapshot(events, code, report);
    snapshots.push({
      ...base,
      direction,
      pickupPoint: text(asObject(shipment["point"])["name"]),
      // The locker's pick-up code opens a locker: it never goes into the stored payload.
      raw: { ...shipment, resolved_pick_up_code: undefined, tracking_events: events ?? [] },
    });
  }
  return { snapshots, complete: true };
}
