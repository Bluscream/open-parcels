import {
  asObject,
  carrierKey,
  readObject,
  SignInRejectedError,
  text,
  TransientError,
  UnexpectedResponseError,
  type HttpResponse,
  type Json,
  type PluginHttp,
  type PluginLogger,
  type SessionStore,
} from "../../plugin/api.js";
import { STRINGS } from "./parse.js";

export const SSO_HOST = "sso.seur.com";
export const WEB_HOST = "www.seur.com";
const TOKEN_URL = `https://${SSO_HOST}/auth/realms/WEB_PUBLICA_PRO/protocol/openid-connect/token`;
const BACKEND = `https://${WEB_HOST}/miseur-contratacion/backend`;

/** The web client's own headers; the backend checks the origin. */
const WEB_HEADERS = {
  accept: "application/json",
  "content-type": "application/json",
  origin: "https://www.seur.com",
  referer: "https://www.seur.com/miseur/home",
};

export interface Credentials {
  readonly username: string;
  readonly password: string;
}

/** The access token lives about a day and comes without a refresh token. */
interface Session {
  readonly accessToken: string;
  readonly uuid: string;
  readonly username: string;
}

function readSession(value: unknown, username: string): Session | null {
  const object = asObject(value);
  const accessToken = text(object["accessToken"], STRINGS);
  const uuid = text(object["uuid"], STRINGS);
  return accessToken !== null && uuid !== null && object["username"] === username
    ? { accessToken, uuid, username }
    : null;
}

function json(response: HttpResponse, what: string): Json {
  return readObject(response, `SEUR ${what}`);
}

function backendFailed(body: Json): boolean {
  return text(body["codigo_error"], STRINGS) !== null || text(body["msg_error"], STRINGS) !== null;
}

async function signIn(http: PluginHttp, credentials: Credentials): Promise<Session> {
  const username = credentials.username.trim();
  const form = new URLSearchParams({
    grant_type: "password",
    client_id: carrierKey("seur", "client_id"),
    username,
    password: credentials.password,
  });
  const tokenResponse = await http.request(new URL(TOKEN_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form,
  });
  if (
    tokenResponse.status === 401 ||
    (tokenResponse.status === 400 && tokenResponse.body.includes("invalid_grant"))
  ) {
    throw new SignInRejectedError("SEUR refused the email or password.");
  }
  if (tokenResponse.status !== 200) {
    throw new TransientError(`SEUR sign-in answered HTTP ${tokenResponse.status}.`);
  }
  const accessToken = text(json(tokenResponse, "sign-in")["access_token"], STRINGS);
  if (accessToken === null) {
    throw new UnexpectedResponseError("SEUR sign-in returned no access token.");
  }
  const profileResponse = await http.request(new URL(`${BACKEND}/consultarDatosUsuario`), {
    method: "POST",
    headers: { ...WEB_HEADERS, authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ username, idioma: "es" }),
  });
  const profile = json(profileResponse, "profile");
  if (profileResponse.status !== 200 || backendFailed(profile)) {
    throw new UnexpectedResponseError(`SEUR profile answered HTTP ${profileResponse.status}.`);
  }
  const user = asObject(profile["usuario"]);
  const uuid = text(user["uuid"], STRINGS);
  const known = text(user["username"], STRINGS);
  if (uuid === null) {
    throw new UnexpectedResponseError("SEUR profile carried no account id.");
  }
  if (known !== null && known.toLowerCase() !== username.toLowerCase()) {
    throw new SignInRejectedError("SEUR returned a different account than the one signed in.");
  }
  return { accessToken, uuid, username };
}

async function inbox(http: PluginHttp, session: Session): Promise<HttpResponse> {
  return http.request(new URL(`${BACKEND}/consultarMisEnvios`), {
    method: "POST",
    headers: { ...WEB_HEADERS, authorization: `Bearer ${session.accessToken}` },
    body: JSON.stringify({
      idioma: "ES",
      uuid: session.uuid,
      email: session.username,
      type: "[Shippings] Get Shipping List From Api",
    }),
  });
}

export interface Inbox {
  readonly incoming: readonly Json[];
  readonly outgoing: readonly Json[];
}

/**
 * Reads the account's shipment lists. A stored token SEUR refuses (401) is replaced by one new
 * sign-in; any other failure, including network errors, ends the run without signing in.
 */
export async function readInbox(
  http: PluginHttp,
  store: SessionStore,
  credentials: Credentials,
  logger: PluginLogger,
): Promise<Inbox> {
  let session = readSession(store.load(), credentials.username.trim());
  if (session === null) {
    session = await signIn(http, credentials);
    await store.save(session);
  }
  let response = await inbox(http, session);
  if (response.status === 401) {
    logger.info({}, "SEUR refused the stored token; signing in once.");
    session = await signIn(http, credentials);
    await store.save(session);
    response = await inbox(http, session);
  }
  if (response.status === 401) {
    throw new SignInRejectedError("SEUR refused a fresh token.");
  }
  if (response.status !== 200) {
    throw new TransientError(`SEUR shipment list answered HTTP ${response.status}.`);
  }
  const body = json(response, "shipment list");
  const received = body["recibidos"];
  const sent = body["enviados"];
  if (backendFailed(body) || !Array.isArray(received) || !Array.isArray(sent)) {
    throw new UnexpectedResponseError("SEUR shipment list had an unexpected shape.");
  }
  const objects = (list: unknown[]): Json[] =>
    list.filter((item): item is Json => typeof item === "object" && item !== null);
  return { incoming: objects(received), outgoing: objects(sent) };
}
