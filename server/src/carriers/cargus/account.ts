import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  asArray as asList,
  asObject,
  carrierKey,
  CookieJar,
  isObject,
  mayHaveMorePages,
  parseJsonBody,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  unescapeHtml,
  text,
  type HttpResponse,
  type Json,
  type PluginHttp,
  type SessionStore,
} from "../../plugin/api.js";
import { API_BASE, appHeaders, CARRIER_ID, PORTAL, portalPhoneKey, readBody } from "./shared.js";

export const B2C_HOST = "mycargus.b2clogin.com";
const POLICY = "B2C_1A_ACCOUNTLINK_SUSI_WEB";
const B2C = `https://${B2C_HOST}/myCargus.onmicrosoft.com/${POLICY}`;
const REDIRECT_URI = `${PORTAL}/authentication/login-callback`;
const REFRESH_MARGIN_MS = 300_000;
/** The list types the portal walks; their meaning is not documented. */
const SHIPMENT_TYPES = [0, 1, 2, 3, 4] as const;

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

const tokensSchema = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expiresAt: z.number(),
  variant: z.enum(["web", "app"]).optional(),
});
type Tokens = z.infer<typeof tokensSchema>;

const scope = (): string => `${carrierKey(CARRIER_ID, "api_scope")} offline_access openid profile`;
const browserAgent = (): string => carrierKey(CARRIER_ID, "browser_user_agent");
const b64url = (bytes: Buffer): string => bytes.toString("base64url");
/** The transaction id is sent with its `=` kept, as the website does. */
const quoted = (value: string): string => encodeURIComponent(value).replaceAll("%3D", "=");

/** The token endpoint explicitly refused a refresh token (HTTP 400/401). */
class RefreshRefused extends Error {
  override readonly name = "RefreshRefused";
}

function tokensFrom(response: HttpResponse, now: number, previousRefresh?: string): Tokens {
  const payload = parseJsonBody(response.body);
  const access = isObject(payload) ? text(payload["access_token"]) : null;
  const refresh = isObject(payload) ? (text(payload["refresh_token"]) ?? previousRefresh) : null;
  if (access === null || refresh === null || refresh === undefined) {
    throw new UnexpectedResponseError("MyCargus answered a token request without tokens.");
  }
  const lifetime = isObject(payload) ? Number(payload["expires_in"]) : Number.NaN;
  return {
    access,
    refresh,
    expiresAt: now + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 3600) * 1000,
  };
}

function setting(page: string, name: string): string | null {
  const decoded = unescapeHtml(page).replaceAll("\\u0026", "&").replaceAll("\\/", "/");
  return new RegExp(`["']${name}["']\\s*:\\s*["']([^"']+)["']`).exec(decoded)?.[1] ?? null;
}

/**
 * The MyCargus website's sign-in (Azure AD B2C, authorization code with PKCE), scripted as the
 * website does it. A rejected password is the user's to fix; anything else is transient.
 */
export async function signIn(
  http: PluginHttp,
  credentials: Credentials,
  now: number,
): Promise<Tokens> {
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  const jar = new CookieJar();
  const browser = { "user-agent": browserAgent(), "accept-language": "ro-RO,ro;q=0.9,en;q=0.7" };
  const authorize = new URL(`${B2C}/oauth2/v2.0/authorize`);
  authorize.search = new URLSearchParams({
    client_id: carrierKey(CARRIER_ID, "client_id"),
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: scope(),
    state,
    nonce: b64url(randomBytes(16)),
    prompt: "login",
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    "client-request-id": randomUUID(),
    response_mode: "query",
  }).toString();
  const page = await http.request(authorize, {
    headers: { ...browser, accept: "text/html" },
    jar,
    redirect: "follow",
  });
  const tx = setting(page.body, "transId");
  const csrf =
    setting(page.body, "csrf") ??
    (await jar.getCookies(`https://${B2C_HOST}/`)).find((c) => c.key === "x-ms-cpim-csrf")?.value ??
    null;
  if (page.status !== 200 || tx === null || csrf === null) {
    throw new UnexpectedResponseError("The MyCargus sign-in page has no form state.");
  }
  const asserted = await http.request(new URL(`${B2C}/SelfAsserted?tx=${quoted(tx)}&p=${POLICY}`), {
    method: "POST",
    headers: {
      ...browser,
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
      "x-csrf-token": csrf,
      origin: `https://${B2C_HOST}`,
      referer: page.url,
    },
    body: new URLSearchParams({
      request_type: "RESPONSE",
      signInName: credentials.username,
      password: credentials.password,
    }),
    jar,
    redirect: "manual",
  });
  const assertedStatus = text(asObject(parseJsonBody(asserted.body))["status"]);
  if ([400, 401, 403].includes(asserted.status) || (assertedStatus ?? "200") !== "200") {
    throw new SignInRejectedError("MyCargus rejected the e-mail address or password.");
  }
  if (asserted.status !== 200) {
    throw new TransientError(`MyCargus sign-in answered HTTP ${asserted.status}.`);
  }
  const confirmed = await http.request(
    new URL(
      `${B2C}/api/CombinedSigninAndSignup/confirmed?rememberMe=false&csrf_token=${encodeURIComponent(csrf)}&tx=${quoted(tx)}&p=${POLICY}`,
    ),
    { headers: { ...browser, accept: "text/html", referer: page.url }, jar, redirect: "manual" },
  );
  const location = confirmed.headers.get("location") ?? "";
  const back = URL.canParse(location) ? new URL(location) : null;
  const code = back?.searchParams.get("code") ?? null;
  if (code === null || back?.searchParams.get("state") !== state) {
    throw new UnexpectedResponseError("MyCargus asked for a sign-in step this service cannot do.");
  }
  const token = await http.request(new URL(`${B2C}/oauth2/v2.0/token`), {
    method: "POST",
    headers: { "user-agent": browserAgent(), accept: "application/json" },
    body: new URLSearchParams({
      client_id: carrierKey(CARRIER_ID, "client_id"),
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      scope: scope(),
    }),
  });
  if (token.status !== 200) {
    throw new TransientError(`MyCargus token exchange answered HTTP ${token.status}.`);
  }
  return tokensFrom(token, now);
}

async function refresh(http: PluginHttp, tokens: Tokens, now: number): Promise<Tokens> {
  const response = await http.request(new URL(`${B2C}/oauth2/v2.0/token`), {
    method: "POST",
    headers: { "user-agent": browserAgent(), accept: "application/json" },
    body: new URLSearchParams({
      client_id: carrierKey(CARRIER_ID, "client_id"),
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
      scope: scope(),
    }),
  });
  if (response.status === 400 || response.status === 401) {
    throw new RefreshRefused("refresh refused");
  }
  if (response.status !== 200) {
    throw new TransientError(`MyCargus token refresh answered HTTP ${response.status}.`);
  }
  return { ...tokensFrom(response, now, tokens.refresh), variant: tokens.variant };
}

const AWB_KEYS = ["awbBarCode", "awbBarcode", "barCode", "barcode", "awb"] as const;

export function awbOf(row: Json): string | null {
  for (const key of AWB_KEYS) {
    const value = text(row[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
}

function rowsOf(payload: unknown): Json[] | null {
  if (payload === null) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload.filter(isObject);
  }
  const holder = asObject(payload);
  const key = ["data", "items", "awbs", "result", "results"].find((name) =>
    Array.isArray(holder[name]),
  );
  return key === undefined ? null : asList(holder[key]).filter(isObject);
}

/**
 * The signed-in MyCargus backend. A valid token is reused, an old one refreshed; only a refresh
 * the carrier refuses leads to a sign-in with the stored password, never a network error. Both
 * header variants (the portal's and the app's) carry the phone number; the one that works is
 * remembered.
 */
export class CargusAccount {
  #tokens: Tokens | null;
  #changed = false;
  /** One renewal per run (an account object lives for one run), not one per request. */
  #renewed = false;

  constructor(
    private readonly http: PluginHttp,
    private readonly credentials: Credentials,
    private readonly phone: string,
    private readonly now: () => number,
    stored: unknown,
  ) {
    const parsed = tokensSchema.safeParse(stored);
    this.#tokens = parsed.success ? parsed.data : null;
  }

  async save(session: SessionStore): Promise<void> {
    if (this.#changed && this.#tokens !== null) {
      await session.save(this.#tokens);
    }
  }

  #store(tokens: Tokens): string {
    this.#tokens = tokens;
    this.#changed = true;
    return tokens.access;
  }

  async #access(force: boolean): Promise<string> {
    const tokens = this.#tokens;
    if (!force && tokens !== null && tokens.expiresAt - REFRESH_MARGIN_MS > this.now()) {
      return tokens.access;
    }
    if (tokens !== null) {
      try {
        return this.#store(await refresh(this.http, tokens, this.now()));
      } catch (error) {
        if (!(error instanceof RefreshRefused)) {
          throw error;
        }
      }
    }
    return this.#store(await signIn(this.http, this.credentials, this.now()));
  }

  #headers(variant: "web" | "app", token: string): Record<string, string> {
    const common = { accept: "application/json", authorization: `Bearer ${token}` };
    if (variant === "app") {
      return { ...common, ...appHeaders(this.phone) };
    }
    return {
      ...common,
      K: portalPhoneKey(this.phone),
      Source: "1",
      origin: PORTAL,
      referer: `${PORTAL}/`,
      "user-agent": browserAgent(),
    };
  }

  /** One signed-in GET. A 401 renews the token once per run; a 400/403 tries the other variant once. */
  async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${API_BASE}/${path}`);
    url.search = new URLSearchParams(params).toString();
    const first = this.#tokens?.variant ?? "web";
    const variants = first === "web" ? (["web", "app"] as const) : (["app", "web"] as const);
    let token = await this.#access(false);
    for (let index = 0; index < variants.length;) {
      const variant = variants[index] ?? "web";
      const response = await this.http.request(url, {
        headers: this.#headers(variant, token),
        maxBytes: 1024 * 1024,
      });
      if (response.status === 401 && !this.#renewed) {
        this.#renewed = true;
        token = await this.#access(true);
        continue;
      }
      if (response.status === 400 || response.status === 403) {
        index += 1;
        continue;
      }
      if (response.status !== 200 && response.status !== 204) {
        throw new TransientError(`MyCargus ${path} answered HTTP ${response.status}.`);
      }
      if (this.#tokens !== null && this.#tokens.variant !== variant) {
        this.#store({ ...this.#tokens, variant });
      }
      return readBody(response, `MyCargus ${path}`);
    }
    throw new TransientError(
      `MyCargus refused ${path} with both header variants; check the phone number.`,
    );
  }

  /** Every inbox row, one per AWB, across the list types. Any list failing fails the read. */
  async inbox(): Promise<{ rows: Json[]; complete: boolean }> {
    const rows = new Map<string, Json>();
    let complete = true;
    for (const type of SHIPMENT_TYPES) {
      const envelope = await this.get("Awbs/AwbList", { shipmentType: String(type), lang: "EN" });
      const found = rowsOf(envelope);
      if (found === null) {
        throw new UnexpectedResponseError("The MyCargus inbox has an unexpected shape.");
      }
      // Paging is not documented: a list that says it holds more is not everything.
      complete &&= !mayHaveMorePages(envelope, found.length);
      for (const row of found) {
        const awb = awbOf(row);
        if (awb === null) {
          complete = false;
        } else if (!rows.has(awb)) {
          rows.set(awb, row);
        }
      }
    }
    return { rows: [...rows.values()], complete };
  }
}
