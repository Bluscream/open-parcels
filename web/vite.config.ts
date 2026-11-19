import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const API_TARGET = process.env["OPENPARCELS_DEV_API"] ?? "http://127.0.0.1:3000";

/** In dev the server is not there to fill in the base path, so use the root. */
function devBase(): Plugin {
  return {
    name: "open-parcels-dev-base",
    apply: "serve",
    transformIndexHtml: (html) => html.replaceAll("%OPENPARCELS_BASE%", "/"),
  };
}

export default defineConfig({
  // Relative asset URLs: they resolve against <base href>, which the server sets per request, so
  // the same build works at / and under a Home Assistant ingress prefix.
  base: "./",
  plugins: [react(), devBase()],
  server: {
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: false },
      "/img": { target: API_TARGET },
      "/ical": { target: API_TARGET },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
