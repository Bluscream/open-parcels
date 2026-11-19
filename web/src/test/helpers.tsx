import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, type RenderResult } from "@testing-library/react";
import { vi } from "vitest";
import { createQueryClient } from "../api/client";
import { setCsrfToken } from "../api/fetcher";
import type { Parcel } from "../api/types";
import { App } from "../App";
import { createAppRouter } from "../router";

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

type Handler = (request: Recorded) => { status?: number; body?: unknown } | undefined;

/** Replaces fetch with a table of `METHOD /path` handlers and records every call. */
export function mockApi(routes: Record<string, Handler>): Recorded[] {
  const calls: Recorded[] = [];
  setCsrfToken(null);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = init.method ?? "GET";
      const request: Recorded = {
        method,
        path: url.pathname,
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
      };
      calls.push(request);
      const result = routes[`${method} ${url.pathname}`]?.(request) ?? {
        status: 404,
        body: { error: "not_found", message: "No such route in the test." },
      };
      const status = result.status ?? 200;
      return Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(result.body ?? null), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return calls;
}

export function renderApp(path = "/"): RenderResult {
  // The app's own client, so its 401 handling is what the tests see; no retries in tests.
  const client = createQueryClient();
  client.setDefaultOptions({
    ...client.getDefaultOptions(),
    queries: { ...client.getDefaultOptions().queries, retry: false },
  });
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  return render(
    <QueryClientProvider client={client}>
      <App router={router} />
    </QueryClientProvider>,
  );
}

export const SIGNED_IN = {
  authenticated: true,
  method: "session",
  scopes: ["read", "write", "admin"],
  csrf_token: "csrf-test-value",
  setup_required: false,
};

/** A made-up parcel; every value is invented. */
export function parcel(overrides: Partial<Parcel> = {}): Parcel {
  const base: Omit<Parcel, "display_name"> = {
    id: "00000000-0000-4000-8000-000000000001",
    carrier: "dhl",
    barcode: "TEST0000000001",
    sender: null,
    receiver: null,
    status: "in_transit",
    raw_status: "On its way",
    delivered: false,
    delivered_at: null,
    planned_from: null,
    planned_to: null,
    pickup: false,
    pickup_point: null,
    history: [],
    url: null,
    direction: "incoming",
    label: null,
    manual_status: null,
    carrier_status: "in_transit",
    carrier_delivered: false,
    archived_at: null,
    items: [],
    live: null,
    location: null,
    last_scan: null,
    order: null,
    sources: [],
    lookup: { state: "found", since: null, checked_at: null },
    first_seen_at: "2026-11-01T10:00:00.000Z",
    updated_at: "2026-11-18T10:00:00.000Z",
    ...overrides,
  };
  return { ...base, display_name: overrides.display_name ?? base.label ?? base.barcode };
}
