import {
  asObject,
  isObject,
  parseJsonBody,
  text,
  TransientError,
  UnexpectedResponseError,
  type CookieJar,
  type Json,
  type PluginContext,
} from "../../plugin/api.js";
import {
  acceptLanguage,
  COOKIE_XSRF,
  FETCH_HEADERS,
  HEADER_XSRF,
  NAVIGATION_HEADERS,
  NOT_FOUND_ERROR_CODE,
  PUBLIC_HOST,
  PUBLIC_TIMEOUT_MS,
  PUBLIC_TRACK_PATH,
} from "./keys.js";

type Deps = Pick<PluginContext<unknown, unknown>, "http" | "logger">;

/**
 * The bot guard in front of the public tracking turned the request away: it hung until the
 * timeout, or answered with a challenge page instead of seeding the session. Transient: the
 * source stands down and tries again later. `hung` is set only when nothing came back at all,
 * which is the one sign that the address's allowance is spent.
 */
export class BotGuardError extends TransientError {
  override readonly name = "BotGuardError";

  constructor(
    message: string,
    readonly hung: boolean,
  ) {
    super(message);
  }
}

/** Requests the public tracking sent, for the budget; a retry after a 401 is a second one. */
export interface Counter {
  sent: number;
}

const trackUrl = (locale: string): URL => {
  const url = new URL(`https://${PUBLIC_HOST}${PUBLIC_TRACK_PATH}`);
  url.searchParams.set("loc", locale);
  return url;
};

/** Whether a failed request timed out, i.e. the guard never answered. */
function timedOut(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error && cause.name === "TimeoutError";
}

/** Runs one public request, turning a hang into a `BotGuardError`. */
async function guarded<T>(what: string, send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (timedOut(error)) {
      throw new BotGuardError(`UPS's ${what} never answered (bot guard).`, true);
    }
    throw error;
  }
}

async function xsrf(jar: CookieJar): Promise<string | null> {
  const cookies = await jar.getCookies(`https://${PUBLIC_HOST}/`);
  const value = cookies.find((cookie) => cookie.key === COOKIE_XSRF)?.value;
  return value === undefined || value === "" ? null : value;
}

/**
 * GETs the tracking endpoint to seed the cookie jar, including the CSRF cookie. A 200 without that
 * cookie is a challenge page, not the tracking app: no lookup could succeed, so none is sent.
 */
async function bootstrap(deps: Deps, jar: CookieJar, locale: string): Promise<string> {
  const response = await guarded("session start", () =>
    deps.http.request(trackUrl(locale), {
      headers: { ...NAVIGATION_HEADERS, "accept-language": acceptLanguage(locale) },
      jar,
      timeoutMs: PUBLIC_TIMEOUT_MS,
    }),
  );
  if (response.status === 403) {
    throw new BotGuardError("UPS's bot guard refused the session start (HTTP 403).", false);
  }
  if (response.status !== 200) {
    throw new TransientError(`UPS's session start answered HTTP ${response.status}.`);
  }
  const token = await xsrf(jar);
  if (token === null) {
    deps.logger.warn(
      { bytes: response.body.length },
      "UPS answered the session start without a CSRF cookie.",
    );
    throw new BotGuardError("UPS answered with a challenge page instead of a session.", false);
  }
  return token;
}

/** One public session: its cookies, the locale it speaks and the requests it sent. */
interface Session {
  readonly jar: CookieJar;
  readonly locale: string;
  readonly counter: Counter;
}

async function post(
  deps: Deps,
  { jar, locale, counter }: Session,
  token: string,
  code: string,
): Promise<{ status: number; body: string }> {
  counter.sent += 1;
  const response = await guarded("tracking lookup", () =>
    deps.http.request(trackUrl(locale), {
      method: "POST",
      headers: {
        ...FETCH_HEADERS,
        "accept-language": acceptLanguage(locale),
        [HEADER_XSRF]: token,
      },
      body: JSON.stringify({
        Locale: locale,
        TrackingNumber: [code],
        isBarcodeScanned: false,
        Requester: "quic",
        ClientUrl: "https://www.ups.com/track",
        returnToValue: "",
        AssociatedBcdnNumber: null,
      }),
      jar,
      timeoutMs: PUBLIC_TIMEOUT_MS,
    }),
  );
  return { status: response.status, body: response.body };
}

function readDetail(status: number, body: string): Json | null {
  if (status === 403) {
    throw new BotGuardError("UPS's bot guard refused the lookup (HTTP 403).", false);
  }
  if (status !== 200) {
    throw new TransientError(`UPS's tracking lookup answered HTTP ${status}.`);
  }
  const payload = parseJsonBody(body);
  if (!isObject(payload)) {
    // The guard sometimes answers a lookup with an HTML shell instead of JSON.
    throw new BotGuardError("UPS answered the lookup with a page instead of data.", false);
  }
  const details = payload["trackDetails"];
  if (!Array.isArray(details) || details.length === 0) {
    throw new UnexpectedResponseError("UPS's lookup carried no trackDetails.");
  }
  const detail = asObject(details[0]);
  const errorCode = text(detail["errorCode"]);
  if (errorCode === NOT_FOUND_ERROR_CODE) {
    return null;
  }
  if (errorCode !== null) {
    throw new UnexpectedResponseError(`UPS's lookup answered error code ${errorCode}.`);
  }
  return detail;
}

/**
 * Looks one code up on the public tracking. Bootstraps the session when it has no CSRF cookie,
 * and once more on a 401 (an expired session), then gives up. Returns null when UPS does not know
 * the number.
 */
export async function lookUpPublic(
  deps: Deps,
  jar: CookieJar,
  code: string,
  locale: string,
  counter: Counter,
): Promise<Json | null> {
  const session: Session = { jar, locale, counter };
  const token = (await xsrf(jar)) ?? (await bootstrap(deps, jar, locale));
  let answer = await post(deps, session, token, code);
  if (answer.status === 401) {
    deps.logger.info({}, "UPS session expired; starting a new one. This costs a second request.");
    const renewed = await bootstrap(deps, jar, locale);
    answer = await post(deps, session, renewed, code);
    if (answer.status === 401) {
      throw new TransientError("UPS refused a freshly started session (HTTP 401).");
    }
  }
  return readDetail(answer.status, answer.body);
}
