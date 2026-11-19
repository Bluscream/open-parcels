import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext, type TestContext } from "../helpers.js";

const HTML = { accept: "text/html,application/xhtml+xml" };

describe("web UI serving", () => {
  let ctx: TestContext;
  let webDir: string;

  beforeEach(async () => {
    ctx = await createTestContext();
    webDir = mkdtempSync(path.join(tmpdir(), "open-parcels-web-"));
    mkdirSync(path.join(webDir, "assets"));
    writeFileSync(
      path.join(webDir, "index.html"),
      '<html><head><base href="%OPENPARCELS_BASE%"></head><body>ui</body></html>',
    );
    writeFileSync(path.join(webDir, "assets", "app-1234.js"), "console.log(1)");
  });

  afterEach(async () => {
    await ctx.close();
    rmSync(webDir, { recursive: true, force: true });
  });

  it("serves index.html at / and for client-side routes", async () => {
    const app = await ctx.app({ webDir });
    for (const url of ["/", "/parcels/abc", "/sources?x=1"]) {
      const response = await app.inject({ url, headers: HTML });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<base href="/">');
    }
  });

  it("serves hashed assets with long caching", async () => {
    const app = await ctx.app({ webDir });
    const response = await app.inject({ url: "/assets/app-1234.js" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("immutable");
  });

  it("never shadows API, feed or image routes", async () => {
    const app = await ctx.app({ webDir });
    for (const url of ["/api/v1/nope", "/api", "/ical/x", "/img/x"]) {
      const response = await app.inject({ url, headers: HTML });
      // A real route may reject the shape (400); either way it is the server's JSON, not the UI.
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.headers["content-type"]).toContain("application/json");
    }
    const health = await app.inject({ url: "/api/v1/health/live", headers: HTML });
    expect(health.statusCode).toBe(200);
  });

  it("does not serve the raw template", async () => {
    const app = await ctx.app({ webDir });
    const response = await app.inject({ url: "/index.html" });
    expect(response.body).not.toContain("%OPENPARCELS_BASE%");
  });

  it("uses the ingress path only on the ingress listener", async () => {
    const ingressPath = "/api/hassio_ingress/abc123";
    const plain = await ctx.app({ webDir });
    const direct = await plain.inject({
      url: "/",
      headers: { ...HTML, "x-ingress-path": ingressPath },
    });
    expect(direct.body).toContain('<base href="/">');

    const ingress = await ctx.app({ webDir, trustedIngressAddress: "127.0.0.1" });
    const viaIngress = await ingress.inject({
      url: "/",
      headers: { ...HTML, "x-ingress-path": ingressPath },
    });
    expect(viaIngress.body).toContain(`<base href="${ingressPath}/">`);
  });

  it("runs API-only without a build", async () => {
    const app = await ctx.app({ webDir: path.join(webDir, "missing") });
    const response = await app.inject({ url: "/", headers: HTML });
    expect(response.statusCode).toBe(404);
  });
});
