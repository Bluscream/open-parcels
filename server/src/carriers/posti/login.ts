import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  CookieJar,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  isObject,
  parseJsonBody,
  restoreJar,
  serializeJar,
  text,
  unescapeHtml,
  walkHtml,
  type InteractiveSignIn,
  type PluginHttp,
  type SignInOption,
} from "../../plugin/api.js";
import { provision, type Device, type Tokens } from "./device.js";
import { POSTI_APP } from "./keys.js";

/*
 * OmaPosti login with strong authentication: the user identifies with their bank or mobile ID in
 * their own browser. The server opens the login, lists the methods, hands over the bank's address
 * and finishes from the address the browser ends on, all in one cookie session.
 */

export interface PostiSecret {
  readonly device: Device;
  readonly idToken: string;
  readonly roleTokens: Tokens["roleTokens"];
}

/** What an in-app web view sends. Posti ties the code to the PKCE challenge only for these. */
const BROWSER_HEADERS = {
  "user-agent": POSTI_APP.webViewUserAgent,
  "x-requested-with": POSTI_APP.appPackage,
  "x-posti-mobile": "android",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
const FORM_HEADERS = {
  "user-agent": POSTI_APP.appUserAgent,
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
};
const METHOD_LINK = /\/uas\/authn\/[^\s"'<>]*?\/select\?[^\s"'<>]*/g;
/** Mobile ID first, then the banks in the order Finns know them. */
const METHOD_ORDER = ["mobileid", "aktia", "danske", "nordea", "omasp", "op", "pop", "spankki"];
const METHOD_LABELS: Readonly<Record<string, string>> = {
  mobileid: "Mobiilivarmenne (mobile ID)",
  danske: "Danske Bank",
  op: "OP",
  omasp: "Oma Säästöpankki",
  pop: "POP Pankki",
  spankki: "S-Pankki",
  saastopankki: "Säästöpankki",
  alandsbanken: "Ålandsbanken",
};

const stateSchema = z.object({
  verifier: z.string(),
  jar: z.unknown(),
  methods: z.record(z.string(), z.string()).optional(),
});

function page(html: string): { hidden: Map<string, string>; forms: string[] } {
  const hidden = new Map<string, string>();
  const forms: string[] = [];
  walkHtml(html, {
    start(tag, attrs) {
      const name = attrs.get("name");
      const value = attrs.get("value");
      if (tag === "input" && name !== undefined && value !== undefined && !hidden.has(name)) {
        hidden.set(name, value);
      }
      const action = attrs.get("action");
      if (tag === "form" && action !== undefined && action !== "") {
        forms.push(action);
      }
    },
    end: () => undefined,
    data: () => undefined,
  });
  return { hidden, forms };
}

async function browse(http: PluginHttp, jar: CookieJar, url: URL, redirect: "follow" | "manual") {
  const response = await http.request(url, {
    headers: BROWSER_HEADERS,
    jar,
    redirect,
    allowRedirect: (target) =>
      target.protocol === "https:" &&
      (target.hostname === "posti.fi" || target.hostname.endsWith(".posti.fi")),
  });
  if (response.status >= 400) {
    throw new TransientError(`Posti's login page answered HTTP ${response.status}.`);
  }
  return response;
}

function methodLinks(html: string): Map<string, string> {
  const links = new Map<string, string>();
  for (const found of html.matchAll(METHOD_LINK)) {
    const link = unescapeHtml(found[0]);
    const method = new URL(link, `https://${POSTI_APP.uasHost}`).searchParams.get("method") ?? "";
    if (method !== "" && !links.has(method)) {
      links.set(method, link);
    }
  }
  return links;
}

function options(methods: Map<string, string>): SignInOption[] {
  const rank = (id: string): number => {
    const at = METHOD_ORDER.indexOf(id);
    return at === -1 ? METHOD_ORDER.length : at;
  };
  return [...methods.keys()]
    .sort((a, b) => rank(a) - rank(b))
    .map((id) => ({ id, label: METHOD_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1) }));
}

async function bankAddress(http: PluginHttp, jar: CookieJar, link: string): Promise<string> {
  const response = await browse(http, jar, new URL(link, `https://${POSTI_APP.uasHost}`), "follow");
  const { hidden, forms } = page(response.body);
  const request = hidden.get("request");
  const target = forms.find(
    (form) => URL.canParse(form) && new URL(form).hostname === POSTI_APP.bankHost,
  );
  if (request === undefined || target === undefined) {
    throw new UnexpectedResponseError("Posti's login page did not lead to the bank.");
  }
  return `${target}${target.includes("?") ? "&" : "?"}request=${encodeURIComponent(request)}`;
}

/** Only the address Posti's login returns to is accepted; anything else never leaves the server. */
function returnAddress(pasted: string): URL {
  const url = URL.canParse(pasted.trim()) ? new URL(pasted.trim()) : null;
  if (
    url?.protocol !== "https:" ||
    url.hostname !== POSTI_APP.uasHost ||
    !url.pathname.startsWith("/uas/return/") ||
    !url.searchParams.has("code")
  ) {
    throw new SignInRejectedError("That is not the address Posti's login returns to.");
  }
  return url;
}

async function finish(http: PluginHttp, jar: CookieJar, verifier: string, pasted: string) {
  const landing = page((await browse(http, jar, returnAddress(pasted), "follow")).body).hidden;
  const code = landing.get("code");
  const state = landing.get("state");
  if (code === undefined || state === undefined) {
    // A used or expired address ends on an error page without these.
    throw new SignInRejectedError("Posti did not accept the identification. Start again.");
  }
  const callback = new URL(`${POSTI_APP.authService}/device_oidc_callback`);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", state);
  const redirect = await browse(http, jar, callback, "manual");
  const location = redirect.headers.get("location");
  const authorisation =
    location === null ? null : new URL(location, callback).searchParams.get("code");
  if (authorisation === null) {
    throw new SignInRejectedError("Posti did not hand out an authorisation code.");
  }
  const response = await http.request(new URL(`${POSTI_APP.authService}/token_v2`), {
    method: "POST",
    headers: FORM_HEADERS,
    body: new URLSearchParams({
      code: authorisation,
      code_verifier: verifier,
      grant_type: "authorization_code",
    }),
  });
  const body = parseJsonBody(response.body);
  const idToken = isObject(body) ? text(body["id_token"]) : null;
  const refreshToken = isObject(body) ? text(body["refresh_token"]) : null;
  if (!isObject(body) || "error" in body || idToken === null || refreshToken === null) {
    throw new SignInRejectedError("Posti did not hand out tokens for the login.");
  }
  return { idToken, refreshToken };
}

/** The account flow: choose a bank or mobile ID, identify in the browser, paste the address back. */
export function bankSignIn<Config>(): InteractiveSignIn<Config, PostiSecret> {
  return {
    type: "interactive",
    id: "bank_id",
    label: "OmaPosti (bank or mobile ID)",
    kinds: ["account"],
    async start(context) {
      const verifier = randomBytes(32).toString("base64url");
      const started = await context.http.request(new URL(`${POSTI_APP.authService}/device_login`), {
        method: "POST",
        headers: FORM_HEADERS,
        body: new URLSearchParams({
          redirect_uri: POSTI_APP.loginRedirect,
          locale: "en",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        }),
      });
      const body = parseJsonBody(started.body);
      const loginPage = isObject(body) ? text(body["login_url"]) : null;
      if (started.status !== 200 || loginPage === null) {
        throw new TransientError(`Posti's login answered HTTP ${started.status}.`);
      }
      const jar = new CookieJar();
      const methods = methodLinks(
        (await browse(context.http, jar, new URL(loginPage), "follow")).body,
      );
      if (methods.size === 0) {
        throw new UnexpectedResponseError("Posti's login page lists no identification method.");
      }
      return {
        step: {
          kind: "choose_method",
          options: options(methods),
          message: "How do you want to identify yourself to Posti?",
        },
        state: { verifier, jar: serializeJar(jar), methods: Object.fromEntries(methods) },
      };
    },
    async continue(context, rawState, input) {
      const state = stateSchema.parse(rawState);
      const jar = restoreJar(state.jar);
      if (state.methods !== undefined) {
        const link = state.methods[input["choice"] ?? ""];
        if (link === undefined) {
          throw new SignInRejectedError("That identification method is not offered.");
        }
        const url = await bankAddress(context.http, jar, link);
        return {
          step: {
            kind: "open_url",
            url,
            message:
              "Open the address, identify yourself, and paste the address your browser ends on " +
              `(it starts with https://${POSTI_APP.uasHost}/uas/return/).`,
          },
          state: { verifier: state.verifier, jar: serializeJar(jar) },
        };
      }
      const login = await finish(context.http, jar, state.verifier, input["pasted"] ?? "");
      const { device, tokens } = await provision(context.http, context.clock, login);
      return { secret: { device, idToken: tokens.idToken, roleTokens: tokens.roleTokens } };
    },
  };
}
