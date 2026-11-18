import type { PluginHttp } from "../../plugin/http.js";
import { TransientError, UnexpectedResponseError, type HttpResponse } from "../../plugin/api.js";
import { asObject, isObject, parseJson, text, type Json } from "../_kit/json.js";

/**
 * The CTT Portugal tracker is a low-code web app. There is no credential, but there is an
 * anonymous session: the first call answers 403 and sets the session cookie, which also carries
 * the CSRF token. The app's version tokens change with every deploy; they are public and read
 * from the app's own manifest and script, never pinned.
 */

export const PORTAL_HOST = "appserver.ctt.pt";
const BASE = `https://${PORTAL_HOST}/CustomerArea`;
const SCREEN = `${BASE}/screenservices/CustomerArea/CustomerArea/PublicArea_Detail`;
const SCRIPT_PATH = "/CustomerArea/scripts/CustomerArea.CustomerArea.PublicArea_Detail.mvc.js";
const TRACK_ACTION = "DataActionGetObjectEventsByInputObjectCode";
const MAINTENANCE_ACTION = "DataActionCheckIPLocked";
/** The screen script is large; allow it, but not without bound. */
const SCRIPT_MAX_BYTES = 6 * 1024 * 1024;

interface PortalState {
  moduleVersion: string | null;
  script: string | null;
  apiVersions: Map<string, string>;
  cookie: string | null;
  csrf: string | null;
}

/** Shared by every source; it holds nothing personal, only the anonymous session and versions. */
const state: PortalState = {
  moduleVersion: null,
  script: null,
  apiVersions: new Map(),
  cookie: null,
  csrf: null,
};

/** Forgets everything; tests start from a clean slate. */
export function resetPortal(): void {
  state.moduleVersion = null;
  state.script = null;
  state.apiVersions.clear();
  state.cookie = null;
  state.csrf = null;
}

function ok(response: HttpResponse, what: string): void {
  if (response.status !== 200) {
    throw new TransientError(`CTT ${what} answered HTTP ${response.status}.`);
  }
}

async function moduleVersion(http: PluginHttp): Promise<string> {
  if (state.moduleVersion === null) {
    const response = await http.request(new URL(`${BASE}/moduleservices/moduleversioninfo`));
    ok(response, "version info");
    const token = text(asObject(parseJson(response, "CTT version info"))["versionToken"]);
    if (token === null) {
      throw new UnexpectedResponseError("CTT version info has no token.");
    }
    state.moduleVersion = token;
  }
  return state.moduleVersion;
}

async function screenScript(http: PluginHttp, version: string): Promise<string> {
  if (state.script === null) {
    const manifest = await http.request(new URL(`${BASE}/moduleservices/moduleinfo?${version}`));
    ok(manifest, "manifest");
    const urlVersions = asObject(
      asObject(asObject(parseJson(manifest, "CTT manifest"))["manifest"])["urlVersions"],
    );
    const token = text(urlVersions[SCRIPT_PATH]);
    if (token === null) {
      throw new UnexpectedResponseError("CTT manifest does not list the tracking screen.");
    }
    const script = await http.request(new URL(`https://${PORTAL_HOST}${SCRIPT_PATH}?${token}`), {
      maxBytes: SCRIPT_MAX_BYTES,
    });
    ok(script, "screen script");
    state.script = script.body;
  }
  return state.script;
}

async function apiVersion(http: PluginHttp, action: string): Promise<string> {
  const cached = state.apiVersions.get(action);
  if (cached !== undefined) {
    return cached;
  }
  const script = await screenScript(http, await moduleVersion(http));
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `callDataAction\\(\\s*"${escaped}"\\s*,\\s*"[^"]*"\\s*,\\s*"([^"]+)"`,
  ).exec(script);
  if (match?.[1] === undefined) {
    throw new UnexpectedResponseError(`CTT screen script has no version for ${action}.`);
  }
  state.apiVersions.set(action, match[1]);
  return match[1];
}

/** Takes the anonymous session cookie and its CSRF token from a 403. False when there is none. */
function adoptSession(response: HttpResponse): boolean {
  for (const header of response.headers.getSetCookie()) {
    const match = /^nr2Users=([^;]*)/.exec(header);
    if (match?.[1] === undefined) {
      continue;
    }
    // `crf%3d<token>%3buid%3d0%3b…`: decode, then split on `;` and `=` by hand (a `+` stays a `+`).
    const fields = decodeURIComponent(match[1])
      .split(";")
      .map((segment) => segment.split("="));
    const csrf = fields.find(([key]) => key === "crf")?.[1];
    if (csrf === undefined || csrf === "") {
      return false;
    }
    state.cookie = match[1];
    state.csrf = csrf;
    return true;
  }
  return false;
}

/** One data action. A 403 bootstraps the session once; stale versions are re-read once. */
async function callAction(
  http: PluginHttp,
  action: string,
  variables: Json,
  retries = { session: true, version: true },
): Promise<Json> {
  const body = {
    versionInfo: {
      moduleVersion: await moduleVersion(http),
      apiVersion: await apiVersion(http, action),
    },
    viewName: "CustomerArea.PublicArea_Detail",
    screenData: { variables },
  };
  const response = await http.request(new URL(`${SCREEN}/${action}`), {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=UTF-8",
      accept: "application/json",
      ...(state.cookie === null || state.csrf === null
        ? {}
        : { cookie: `nr2Users=${state.cookie}`, "x-csrftoken": state.csrf }),
    },
    body: JSON.stringify(body),
  });
  if (response.status === 403) {
    if (retries.session && adoptSession(response)) {
      return callAction(http, action, variables, { ...retries, session: false });
    }
    throw new TransientError("CTT refused the anonymous session.");
  }
  ok(response, "tracking");
  const payload = parseJson(response, "CTT tracking");
  if (!isObject(payload)) {
    throw new UnexpectedResponseError("CTT tracking did not answer with an object.");
  }
  const versionInfo = asObject(payload["versionInfo"]);
  if (
    versionInfo["hasModuleVersionChanged"] === true ||
    versionInfo["hasApiVersionChanged"] === true
  ) {
    if (!retries.version) {
      throw new UnexpectedResponseError("CTT still reports stale versions after a refresh.");
    }
    state.moduleVersion = null;
    state.script = null;
    state.apiVersions.delete(action);
    return callAction(http, action, variables, { ...retries, version: false });
  }
  return payload;
}

/**
 * One code's record, or null when CTT does not know it. A not-found during maintenance is an
 * outage, never "unknown code".
 */
export async function lookUpPortal(http: PluginHttp, code: string): Promise<Json | null> {
  const payload = await callAction(http, TRACK_ACTION, {
    ObjectCodeInput: code,
    SearchInput: code,
    IsFromPublicArea: true,
    IPClient: "",
  });
  const record = asObject(payload["data"])["ObjectEventsFromQuery"];
  if (isObject(record) && record["Found"] === true) {
    return record;
  }
  const check = await callAction(http, MAINTENANCE_ACTION, {});
  if (asObject(check["data"])["IsMaintenance"] === true) {
    throw new TransientError("CTT tracking is in maintenance.");
  }
  return null;
}
