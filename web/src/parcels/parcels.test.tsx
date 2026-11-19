import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, parcel, renderApp, SIGNED_IN } from "../test/helpers";

const PARCELS = [
  parcel({ id: "00000000-0000-4000-8000-00000000000a", label: "Book", carrier: "dhl" }),
  parcel({
    id: "00000000-0000-4000-8000-00000000000b",
    barcode: "TEST0000000002",
    carrier: "dpd",
    status: "registered",
    lookup: {
      state: "not_found",
      since: "2026-11-10T10:00:00.000Z",
      checked_at: "2026-11-18T09:00:00.000Z",
    },
  }),
  parcel({
    id: "00000000-0000-4000-8000-00000000000c",
    barcode: "TEST0000000003",
    label: "Shoes",
    carrier: "hermes",
    status: "delivered",
    delivered: true,
  }),
];

function api() {
  return mockApi({
    "GET /api/v1/session": () => ({ body: SIGNED_IN }),
    "GET /api/v1/parcels": () => ({ body: PARCELS }),
    "GET /api/v1/carriers": () => ({ body: [] }),
  });
}

describe("parcel list", () => {
  it("shows active parcels with status, carrier and lookup state", async () => {
    api();
    renderApp();
    const table = await screen.findByRole("table", { name: "Parcels" });
    expect(within(table).getByText("Book")).toBeInTheDocument();
    expect(within(table).getByText("Not found by carrier")).toBeInTheDocument();
    expect(within(table).getByText("dpd")).toBeInTheDocument();
    // Delivered parcels are hidden under the default "Active" filter.
    expect(within(table).queryByText("Shoes")).not.toBeInTheDocument();
  });

  it("filters by delivered, carrier and search", async () => {
    api();
    const user = userEvent.setup();
    renderApp();
    const table = await screen.findByRole("table", { name: "Parcels" });

    await user.click(screen.getByLabelText("Delivered"));
    expect(within(table).getByText("Shoes")).toBeInTheDocument();
    expect(within(table).queryByText("Book")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("All"));
    await user.selectOptions(screen.getByLabelText("Carrier"), "dhl");
    expect(within(table).getByText("Book")).toBeInTheDocument();
    expect(within(table).queryByText("Shoes")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Carrier"), "");
    await user.type(screen.getByLabelText("Search parcels"), "shoes");
    expect(within(table).getByText("Shoes")).toBeInTheDocument();
    expect(within(table).queryByText("Book")).not.toBeInTheDocument();
  });

  it("adds a parcel with carrier detection and sends the CSRF header", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/parcels": () => ({ body: [] }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "POST /api/v1/parcels": () => ({ status: 201, body: PARCELS[0] }),
      "GET /api/v1/parcels/00000000-0000-4000-8000-00000000000a": () => ({ body: PARCELS[0] }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.click(await screen.findByRole("button", { name: "Track a parcel" }));
    await user.type(screen.getByLabelText("Tracking code"), " TEST0000000009 ");
    await user.click(screen.getByRole("button", { name: "Track" }));

    expect(await screen.findByRole("heading", { name: "Book" })).toBeInTheDocument();
    const post = calls.find((call) => call.method === "POST" && call.path === "/api/v1/parcels");
    expect(post?.body).toEqual({ barcode: "TEST0000000009", label: null });
    expect(post?.headers.get("x-csrf-token")).toBe("csrf-test-value");
  });
});
