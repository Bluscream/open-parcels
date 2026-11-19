import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";
import type { ServerSetting } from "./server-settings";

// Leaflet needs a real browser; the home card's map is not what these tests are about.
vi.mock("../map/SharedMap", () => ({ SharedMap: () => null }));

/** A made-up server setting; every value is invented. */
function setting(overrides: Partial<ServerSetting> = {}): ServerSetting {
  return {
    key: "OPENPARCELS_ARCHIVE_DAYS",
    group: "Retention",
    description: "Days after delivery before a parcel is archived.",
    kind: "number",
    choices: null,
    apply: "live",
    secret: false,
    source: "default",
    set: true,
    value: 30,
    default: 30,
    pending_restart: false,
    ...overrides,
  };
}

const SECRET = setting({
  key: "OPENPARCELS_SECRET_KEY",
  group: "Storage",
  description: "Encrypts stored credentials.",
  kind: "string",
  apply: "env",
  secret: true,
  source: "env",
  value: null,
  default: null,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings page", () => {
  it("groups server settings into cards, saves and resets one", async () => {
    let archive = setting();
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
      "GET /api/v1/settings/config": () => ({ body: [SECRET, archive] }),
      "PATCH /api/v1/settings/config": (request) => {
        const body = request.body as Record<string, number>;
        archive = setting({ source: "override", value: body["OPENPARCELS_ARCHIVE_DAYS"] ?? 0 });
        return { body: [SECRET, archive] };
      },
      "DELETE /api/v1/settings/config/OPENPARCELS_ARCHIVE_DAYS": () => {
        archive = setting();
        return { body: [SECRET, archive] };
      },
    });
    const user = userEvent.setup();
    renderApp("/settings");

    const retention = await screen.findByRole("region", { name: "Retention" });
    expect(screen.getByRole("region", { name: "Home location" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Default parcel label" })).toBeInTheDocument();
    expect(within(retention).getByText("default")).toBeInTheDocument();
    expect(within(retention).getByText("live")).toBeInTheDocument();

    const storage = screen.getByRole("region", { name: "Storage" });
    expect(within(storage).getByText("Set (hidden)")).toBeInTheDocument();
    expect(within(storage).getByText("environment only")).toBeInTheDocument();
    expect(within(storage).queryByRole("textbox")).not.toBeInTheDocument();

    const input = within(retention).getByLabelText("ARCHIVE_DAYS value");
    await user.clear(input);
    await user.type(input, "45");
    await user.click(within(retention).getByRole("button", { name: "Save ARCHIVE_DAYS" }));
    expect(await within(retention).findByText("saved in UI")).toBeInTheDocument();

    await user.click(within(retention).getByRole("button", { name: "Reset ARCHIVE_DAYS" }));
    expect(await within(retention).findByText("default")).toBeInTheDocument();

    const writes = calls.filter((call) => call.method !== "GET").map((c) => [c.method, c.body]);
    expect(writes).toEqual([
      ["PATCH", { OPENPARCELS_ARCHIVE_DAYS: 45 }],
      ["DELETE", null],
    ]);
  });

  it("flags a restart setting that waits for a restart", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
      "GET /api/v1/settings/config": () => ({
        body: [
          setting({
            key: "OPENPARCELS_TIMEZONE",
            group: "Tracking",
            kind: "string",
            apply: "restart",
            source: "override",
            value: "Asia/Tokyo",
            default: null,
            pending_restart: true,
          }),
        ],
      }),
    });
    renderApp("/settings");
    const tracking = await screen.findByRole("region", { name: "Tracking" });
    expect(within(tracking).getByText("saved, restart to apply")).toBeInTheDocument();
  });

  it("shows a reader the settings read only, without server settings", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({
        body: { ...SIGNED_IN, role: "reader", scopes: ["read"] },
      }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
    });
    renderApp("/settings");
    expect(await screen.findByRole("region", { name: "Default parcel label" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Name parcels by" })).toBeDisabled();
    expect(screen.queryByLabelText("Address or coordinates")).not.toBeInTheDocument();
    expect(screen.getByText(/for the admin only/)).toBeInTheDocument();
    expect(calls.some((call) => call.path === "/api/v1/settings/config")).toBe(false);
  });

  it("changes the admin password on the Security card", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/settings": () => ({ body: { home: null, parcel_label: "tracking_number" } }),
      "GET /api/v1/settings/config": () => ({
        body: [
          {
            key: "OPENPARCELS_ADMIN_PASSWORD",
            group: "Security",
            description: "Password to change anything.",
            kind: "string",
            choices: null,
            apply: "env",
            secret: true,
            source: "override",
            set: true,
            value: null,
            default: null,
            pending_restart: false,
          },
        ],
      }),
      "PUT /api/v1/admin-password": () => ({ status: 204, body: null }),
    });
    const user = userEvent.setup();
    renderApp("/settings");
    const card = await screen.findByRole("region", { name: "Security" });
    const current = ["old", "admin", "secret"].join(" ");
    const next = ["new", "admin", "secret"].join(" ");
    await user.type(within(card).getByLabelText("Current admin password"), current);
    await user.type(within(card).getByLabelText("New admin password"), next);
    await user.type(within(card).getByLabelText("Repeat the new password"), next);
    await user.click(within(card).getByRole("button", { name: "Change admin password" }));
    await waitFor(() => {
      expect(calls.find((call) => call.path === "/api/v1/admin-password")?.body).toEqual({
        current,
        next,
      });
    });
  });
});
