import {
  restoreJar,
  serializeJar,
  TransientError,
  UnexpectedResponseError,
  type CookieJar,
  type HttpResponse,
  type SessionStore,
} from "../../plugin/api.js";
import type { PluginHttp } from "../../plugin/http.js";

export const HOST = "service.post.ch";
const BASE = `https://${HOST}/ekp-web`;
const REFERER = `${BASE}/ui/`;

export type Json = Readonly<Record<string, unknown>>;

export function asObject(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function readJson(response: HttpResponse, what: string): unknown {
  try {
    return response.json();
  } catch {
    throw new UnexpectedResponseError(`Swiss Post ${what} did not answer with JSON.`);
  }
}

/**
 * The anonymous tracker session: a cookie, the CSRF token and the anonymous user id handed out
 * by `/api/user`. It needs no credentials; a 403 means it expired and is replaced once.
 */
export class TrackerSession {
  #user: string | null = null;
  #csrf: string | null = null;

  constructor(
    private readonly http: PluginHttp,
    private readonly jar: CookieJar,
  ) {}

  static restore(http: PluginHttp, store: SessionStore): TrackerSession {
    const saved = asObject(store.load());
    const session = new TrackerSession(http, restoreJar(saved["jar"]));
    session.#user = typeof saved["user"] === "string" ? saved["user"] : null;
    session.#csrf = typeof saved["csrf"] === "string" ? saved["csrf"] : null;
    return session;
  }

  async save(store: SessionStore): Promise<void> {
    await store.save({ jar: serializeJar(this.jar), user: this.#user, csrf: this.#csrf });
  }

  get(path: string, params: Record<string, string> = {}): Promise<HttpResponse> {
    const url = new URL(`${BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return this.http.request(url, {
      jar: this.jar,
      headers: { accept: "application/json", referer: REFERER },
    });
  }

  async #establish(): Promise<void> {
    const response = await this.get("/api/user");
    if (response.status !== 200) {
      throw new TransientError(`Swiss Post session handshake answered HTTP ${response.status}.`);
    }
    const user = asObject(readJson(response, "session handshake"))["userIdentifier"];
    const csrf = response.headers.get("x-csrf-token");
    if (typeof user !== "string" || user === "" || csrf === null || csrf === "") {
      throw new UnexpectedResponseError("Swiss Post session handshake lacked its id or token.");
    }
    this.#user = user;
    this.#csrf = csrf;
  }

  /** Registers the code in this session, then reads back what the session resolved. */
  async #lookUpOnce(code: string): Promise<unknown[] | "expired"> {
    const user = this.#user ?? "";
    const url = new URL(`${BASE}/api/history`);
    url.searchParams.set("userId", user);
    const registration = await this.http.request(url, {
      method: "POST",
      jar: this.jar,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        referer: REFERER,
        "x-csrf-token": this.#csrf ?? "",
      },
      body: JSON.stringify({ searchQuery: code }),
    });
    if (registration.status === 403) {
      return "expired";
    }
    if (registration.status !== 200) {
      throw new TransientError(`Swiss Post registration answered HTTP ${registration.status}.`);
    }
    const digest = asObject(readJson(registration, "registration"))["hash"];
    if (typeof digest !== "string" || digest === "") {
      throw new UnexpectedResponseError("Swiss Post registration returned no hash.");
    }
    // Without the registration above this answers an empty list for every code.
    const result = await this.get(`/api/history/not-included/${encodeURIComponent(digest)}`, {
      userId: user,
    });
    if (result.status === 403) {
      return "expired";
    }
    if (result.status !== 200) {
      throw new TransientError(`Swiss Post shipment answered HTTP ${result.status}.`);
    }
    const shipments = readJson(result, "shipment");
    if (!Array.isArray(shipments)) {
      throw new UnexpectedResponseError("Swiss Post shipment answer was not a list.");
    }
    return shipments as unknown[];
  }

  /** The shipment list for one code; the session is set up or renewed (once) as needed. */
  async lookUp(code: string): Promise<unknown[]> {
    if (this.#user === null || this.#csrf === null) {
      await this.#establish();
    }
    const first = await this.#lookUpOnce(code);
    if (first !== "expired") {
      return first;
    }
    await this.#establish();
    const second = await this.#lookUpOnce(code);
    if (second === "expired") {
      throw new UnexpectedResponseError("Swiss Post refused a fresh tracker session.");
    }
    return second;
  }
}
