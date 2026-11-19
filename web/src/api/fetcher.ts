/**
 * The one place the UI talks HTTP. Every generated call goes through `apiFetch`, which:
 * - resolves `/api/...` against the document base, so the UI works under an ingress prefix;
 * - sends the session cookie and, on state-changing requests, the CSRF header;
 * - turns error bodies into `ApiError`.
 * Nothing here logs or stores request bodies: they can carry passwords and codes.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let csrfToken: string | null = null;

/** Kept in memory only; a reload asks `GET /session` again. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

/** Turns an absolute API path into one relative to `<base href>`. */
export function apiUrl(path: string): string {
  const relative = path.replace(/^\/+/, "");
  return new URL(relative, document.baseURI).toString();
}

interface ErrorBody {
  readonly error?: unknown;
  readonly message?: unknown;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  if (text === "") {
    return null;
  }
  const type = response.headers.get("content-type") ?? "";
  return type.includes("json") ? (JSON.parse(text) as unknown) : text;
}

function toApiError(response: Response, body: unknown): ApiError {
  const parsed: ErrorBody = typeof body === "object" && body !== null ? body : {};
  const code = typeof parsed.error === "string" ? parsed.error : `http_${response.status}`;
  const message =
    typeof parsed.message === "string"
      ? parsed.message
      : `The server answered ${response.status} ${response.statusText}.`;
  const retry = Number(response.headers.get("retry-after"));
  return new ApiError(
    response.status,
    code,
    message,
    Number.isFinite(retry) && retry > 0 ? retry : null,
  );
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (!SAFE_METHODS.has(method) && csrfToken !== null) {
    headers.set("x-csrf-token", csrfToken);
  }
  if (init.body === undefined || init.body === null) {
    headers.delete("content-type");
  }
  const response = await fetch(apiUrl(path), {
    ...init,
    method,
    headers,
    credentials: "same-origin",
  });
  const body = await readBody(response);
  if (!response.ok) {
    throw toApiError(response, body);
  }
  return body as T;
}

export default apiFetch;
