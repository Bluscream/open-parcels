import { defineConfig } from "orval";

/**
 * Generates the typed API functions and types from the server's OpenAPI document. Refresh both
 * with `npm run openapi -w server && npm run api -w web`. The TanStack Query hooks that use them
 * are written by hand in `src/api/queries.ts`, so query keys and invalidation stay in one place.
 */
export default defineConfig({
  openParcels: {
    input: { target: "../docs/openapi.json" },
    output: {
      target: "src/api/generated.ts",
      client: "fetch",
      mode: "single",
      clean: false,
      override: {
        mutator: { path: "src/api/fetcher.ts", name: "apiFetch" },
        fetch: { includeHttpResponseReturnType: false },
      },
    },
  },
});
