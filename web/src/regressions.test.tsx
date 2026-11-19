import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CalendarEntry, Source } from "./api/types";
import { toCalendarEvent } from "./calendar/events";
import { describeLookup } from "./lib/format";
import { SourceStateBadge } from "./parcels/badges";
import { isSecretField } from "./sources/schema";
import { mockApi, parcel, renderApp, SIGNED_IN } from "./test/helpers";

/* Regressions found by a live end-to-end run. Every value is made up. */

const ARCHIVED = parcel({
  id: "00000000-0000-4000-8000-0000000000a1",
  label: "Old lamp",
  archived_at: "2026-11-18T09:00:00.000Z",
});

describe("parcel list", () => {
  it("keeps the Show selection when archived parcels are included", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/parcels": () => ({ body: [ARCHIVED] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("table", { name: "Parcels" });
    await user.click(screen.getByLabelText("All"));
    await user.click(screen.getByLabelText("Include archived"));
    const table = await screen.findByRole("table", { name: "Parcels" });
    expect(screen.getByLabelText("All")).toBeChecked();
    expect(within(table).getByText("Archived")).toBeInTheDocument();
  });
});

describe("a source that ran but had nothing to do", () => {
  it("shows Idle and its reason instead of OK", () => {
    render(
      <SourceStateBadge
        state="ok"
        lastOkAt={null}
        detail="Public tracking off: nothing to look up."
      />,
    );
    expect(screen.getByText("Idle", { selector: ".badge" })).toBeInTheDocument();
  });
});

describe("an ended session and a deleted parcel", () => {
  const ID = "00000000-0000-4000-8000-0000000000b2";
  const SIGNED_OUT = {
    authenticated: false,
    method: null,
    scopes: [],
    csrf_token: null,
    setup_required: false,
  };

  it("goes back to sign-in when a change is refused with 401", async () => {
    let signedIn = true;
    mockApi({
      "GET /api/v1/session": () => ({ body: signedIn ? SIGNED_IN : SIGNED_OUT }),
      [`GET /api/v1/parcels/${ID}`]: () => ({ body: { ...parcel({ id: ID }), sources: [] } }),
      [`PATCH /api/v1/parcels/${ID}`]: () => {
        signedIn = false;
        return { status: 401, body: { error: "unauthorized", message: "Sign in again." } };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp(`/parcels/${ID}`);
    await user.click(await screen.findByRole("button", { name: "Archive" }));
    expect(await screen.findByLabelText("Owner password")).toBeInTheDocument();
  });

  it("does not ask for a deleted parcel's detail again", async () => {
    let deleted = false;
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      [`GET /api/v1/parcels/${ID}`]: () =>
        deleted
          ? { status: 404, body: { error: "not_found", message: "Gone." } }
          : { body: { ...parcel({ id: ID }), sources: [] } },
      [`DELETE /api/v1/parcels/${ID}`]: () => {
        deleted = true;
        return { status: 204 };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderApp(`/parcels/${ID}`);
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await screen.findByRole("table", { name: "Parcels" }).catch(() => undefined);
    await waitFor(() => {
      expect(deleted).toBe(true);
    });
    const detailReads = calls.filter(
      (call) => call.method === "GET" && call.path === `/api/v1/parcels/${ID}`,
    );
    expect(detailReads).toHaveLength(1);
  });
});

describe("parcel detail", () => {
  it("shows an archived parcel as archived, offers Unarchive and names its sources", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/parcels/00000000-0000-4000-8000-0000000000a1": () => ({
        body: {
          ...ARCHIVED,
          sources: [
            {
              source_id: "s1",
              plugin: "dhl",
              label: "DHL account",
              kind: "account",
              role: "primary",
              last_seen_at: "2026-11-18T09:00:00.000Z",
            },
            {
              source_id: "s2",
              plugin: "dhl",
              label: "DHL tracking",
              kind: "tracking",
              role: "primary",
              last_seen_at: "2026-11-18T09:00:00.000Z",
            },
          ],
        },
      }),
      "PATCH /api/v1/parcels/00000000-0000-4000-8000-0000000000a1": () => ({
        body: { ...ARCHIVED, archived_at: null },
      }),
      "GET /api/v1/parcels": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp("/parcels/00000000-0000-4000-8000-0000000000a1");
    await screen.findByRole("heading", { name: "Old lamp" });
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.getByText(/DHL account/)).toBeInTheDocument();
    expect(screen.getByText(/DHL tracking/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Unarchive" }));
    expect(await screen.findByText("Restored from the archive.")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ archived: false });
  });
});

describe("sources", () => {
  const disabled: Source = {
    id: "s3",
    plugin: "dhl",
    kind: "account",
    label: "DHL account",
    config: {},
    has_secret: false,
    state: "disabled",
    state_detail: null,
    next_run_at: null,
    last_run_at: null,
    last_ok_at: null,
  };

  it("offers neither Sync now nor Sign in on a disabled source", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/sources": () => ({ body: [disabled] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    renderApp("/sources");
    await screen.findByRole("heading", { name: "DHL account" });
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in/ })).not.toBeInTheDocument();
  });

  it("shows a source that never had a successful run as not run yet, never OK", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/sources": () => ({
        body: [{ ...disabled, state: "ok", state_detail: "Not run yet." }],
      }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    renderApp("/sources");
    await screen.findByRole("heading", { name: "DHL account" });
    expect(screen.getByText("Not run yet", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.queryByText("OK", { selector: ".badge" })).not.toBeInTheDocument();
  });

  it("masks only real secrets", () => {
    for (const name of ["postalCode", "postal_code", "countryCode", "trackingCode", "keyword"]) {
      expect(isSecretField(name), name).toBe(false);
    }
    for (const name of ["password", "apiKey", "api_key", "refreshToken", "pinCode", "otp"]) {
      expect(isSecretField(name), name).toBe(true);
    }
  });
});

describe("carrier lookup wording", () => {
  const now = Date.parse("2026-11-18T12:00:00.000Z");

  it("leaves out an unknown start instead of saying 'since never'", () => {
    const text = describeLookup(
      { state: "found", since: null, checked_at: "2026-11-18T11:00:00.000Z" },
      now,
    );
    expect(text).toBe("Found by the carrier, last asked 1 hour ago");
    expect(text).not.toContain("never");
  });

  it("names a known start and a parcel never asked", () => {
    expect(
      describeLookup(
        { state: "not_found", since: "2026-11-16T12:00:00.000Z", checked_at: null },
        now,
      ),
    ).toBe("Not found by the carrier 2 days ago, not asked yet");
  });
});

describe("API tokens", () => {
  const token = {
    id: "00000000-0000-4000-8000-0000000000c1",
    name: "Made-up client",
    scopes: ["read"],
    created_at: "2026-11-18T09:00:00.000Z",
    expires_at: null,
  };

  it("re-reads 'last used' when the window regains focus and shows it", async () => {
    let used: string | null = null;
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/tokens": () => ({ body: [{ ...token, last_used_at: used }] }),
    });
    renderApp("/tokens");
    const row = (await screen.findByText("Made-up client")).closest("tr");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("never")).toBeInTheDocument();
    const before = calls.filter((call) => call.path === "/api/v1/tokens").length;

    used = new Date(Date.now() - 60_000).toISOString();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/tokens").length).toBeGreaterThan(before);
    });
    const updated = (await screen.findByText("Made-up client")).closest("tr") as HTMLElement;
    await waitFor(() => {
      expect(within(updated).queryByText("never")).not.toBeInTheDocument();
    });
    expect(within(updated).getByText("1 minute ago")).toBeInTheDocument();
  });
});

describe("calendar", () => {
  it("places all-day entries on the server's local days, not the browser's", () => {
    const entry: CalendarEntry = {
      uid: "p1@open-parcels",
      parcel_id: "00000000-0000-4000-8000-0000000000b1",
      title: "Lamp",
      carrier: "dhl",
      barcode: "TEST0000000009",
      status: "delivered",
      kind: "delivered",
      // Local midnight in Berlin, which a UTC browser would put on the day before.
      start: "2026-11-16T23:00:00.000Z",
      end: "2026-11-17T23:00:00.000Z",
      all_day: true,
      start_date: "2026-11-17",
      end_date: "2026-11-18",
      late: false,
      image_url: null,
      url: null,
      pickup_point: null,
    };
    expect(toCalendarEvent(entry, "DHL")).toMatchObject({
      start: "2026-11-17",
      end: "2026-11-18",
      allDay: true,
    });
  });
});

describe("unknown addresses", () => {
  it("show a styled page with a way back", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/parcels": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
    });
    renderApp("/no/such/page");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the parcels" })).toHaveAttribute("href", "/");
  });
});
