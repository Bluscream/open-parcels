import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** Paths the single-page app never answers, so an unknown API route stays a JSON 404. */
const SERVER_PREFIXES = ["/api/", "/ical/", "/img/"] as const;
const BASE_PLACEHOLDER = "%OPENPARCELS_BASE%";
/** Home Assistant ingress prefixes look like `/api/hassio_ingress/<token>`. */
const INGRESS_PATH = /^\/api\/hassio_ingress\/[\w-]{1,128}$/;

export interface WebUiOptions {
  /** Folder holding the built UI (`index.html` plus `assets/`). */
  readonly root: string;
  /** Only the ingress listener honours the `X-Ingress-Path` header. */
  readonly trustIngressPath: boolean;
}

export function isServerPath(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return (
    pathname === "/api" ||
    pathname === "/ical" ||
    pathname === "/img" ||
    SERVER_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/** The base path the UI is served under: `/`, or the ingress prefix followed by `/`. */
export function basePath(request: FastifyRequest, trustIngressPath: boolean): string {
  const header = request.headers["x-ingress-path"];
  if (trustIngressPath && typeof header === "string" && INGRESS_PATH.test(header)) {
    return `${header}/`;
  }
  return "/";
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function sendIndex(reply: FastifyReply, template: string, base: string): FastifyReply {
  return reply
    .code(200)
    .type("text/html; charset=utf-8")
    .header("cache-control", "no-cache")
    .header("x-content-type-options", "nosniff")
    .header("referrer-policy", "same-origin")
    .send(template.replaceAll(BASE_PLACEHOLDER, escapeAttribute(base)));
}

/**
 * Serves the built web UI: hashed assets as static files, and `index.html` (with the base path
 * filled in) for every other GET that is not an API, feed or image route.
 * Returns false when the folder has no build, so the server runs API-only.
 */
export async function registerWebUi(app: FastifyInstance, options: WebUiOptions): Promise<boolean> {
  const indexFile = path.join(options.root, "index.html");
  if (!existsSync(indexFile)) {
    return false;
  }
  const template = readFileSync(indexFile, "utf8");
  await app.register(fastifyStatic, {
    root: options.root,
    prefix: "/",
    index: false,
    wildcard: false,
    // index.html is only ever sent through the template, never raw.
    allowedPath: (pathName) => pathName !== "/index.html",
    setHeaders: (response, filePath) => {
      const immutable = filePath.includes(`${path.sep}assets${path.sep}`);
      void response.header(
        "cache-control",
        immutable ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      );
    },
  });
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.includes("text/html") ?? false;
    if (request.method === "GET" && !isServerPath(request.url) && acceptsHtml) {
      return sendIndex(reply, template, basePath(request, options.trustIngressPath));
    }
    return reply
      .code(404)
      .send({ error: "not_found", message: `Route ${request.method} ${request.url} not found.` });
  });
  return true;
}
