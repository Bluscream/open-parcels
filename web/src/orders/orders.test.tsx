import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../api/types";
import { mockApi, parcel, renderApp, SIGNED_IN } from "../test/helpers";
import { archiveExplanation } from "./OrderDetailPage";

const ORDER_ID = "00000000-0000-4000-8000-0000000000f1";
const PARCEL_ID = "00000000-0000-4000-8000-0000000000a1";

/** A made-up order; every value is invented. */
function order(overrides: Partial<Order> = {}): Order {
  return {
    id: ORDER_ID,
    shop: "demo_shop",
    order_number: "DEMO-1001",
    label: null,
    display_name: "demo_shop DEMO-1001",
    placed_at: "2026-11-15T10:00:00.000Z",
    status: "partly_delivered",
    archived: false,
    archived_at: null,
    archive_mode: "automatic",
    parcel_count: 2,
    delivered_count: 1,
    total: { amount: 39.9, currency: "EUR" },
    items: [
      {
        title: "Desk lamp",
        image_url: "api/v1/images/abc",
        url: null,
        quantity: 1,
        price: 29.9,
        currency: "EUR",
        parcel_id: PARCEL_ID,
      },
      {
        title: "Gift voucher",
        image_url: null,
        url: null,
        quantity: 1,
        price: 10,
        currency: "EUR",
        parcel_id: null,
      },
    ],
    parcels: [
      {
        id: PARCEL_ID,
        carrier: "demo",
        barcode: "DEMO0000000002",
        direction: "incoming",
        display_name: "Lamp parcel",
        status: "in_transit",
        delivered: false,
        delivered_at: null,
        planned_from: null,
        planned_to: null,
        archived_at: null,
        location: {
          latitude: 52.5,
          longitude: 13.4,
          source: "event",
          precision: "exact",
          name: "Sorting centre",
          address: null,
          at: null,
        },
        url: null,
      },
    ],
    created_at: "2026-11-15T10:00:00.000Z",
    updated_at: "2026-11-18T10:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("orders page", () => {
  it("shows orders with status, pictures and parcels, and switches views", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/orders": (request) => ({
        body:
          request.query.get("view") === "archived"
            ? [order({ archived: true, label: "Old things", display_name: "Old things" })]
            : [order()],
      }),
    });
    const user = userEvent.setup();
    renderApp("/orders");
    const card = await screen.findByRole("region", { name: "demo_shop" });
    expect(within(card).getByText("Partly delivered")).toBeInTheDocument();
    expect(within(card).getByText("DEMO-1001")).toBeInTheDocument();
    expect(within(card).getByText("Lamp parcel")).toBeInTheDocument();
    expect(within(card).getByText("Sorting centre")).toBeInTheDocument();
    // Pictures go through the app's base address (Home Assistant ingress).
    expect(within(card).getByRole("img", { name: "Desk lamp" }).getAttribute("src")).toMatch(
      /api\/v1\/images\/abc$/,
    );
    expect(screen.getByText(/at least one parcel has not arrived/)).toBeInTheDocument();

    await user.click(screen.getByLabelText("Archived"));
    expect(await screen.findByRole("region", { name: "Old things" })).toBeInTheDocument();
    expect(screen.getByText(/that you archived yourself/)).toBeInTheDocument();
    expect(
      calls.filter((call) => call.path === "/api/v1/orders").map((c) => c.query.get("view")),
    ).toEqual(["open", "archived"]);
  });

  it("renames, archives and deletes an order on its page", async () => {
    let current = order();
    const calls = mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      "GET /api/v1/orders": () => ({ body: [] }),
      [`GET /api/v1/orders/${ORDER_ID}`]: () => ({ body: current }),
      [`PATCH /api/v1/orders/${ORDER_ID}`]: (request) => {
        const body = request.body as { label?: string | null; archived?: boolean | null };
        current = order({
          ...(body.label === undefined
            ? {}
            : { label: body.label, display_name: body.label ?? current.display_name }),
          ...(body.archived === true
            ? { archived: true, archive_mode: "archived", archived_at: "2026-11-18T12:00:00.000Z" }
            : {}),
        });
        return { body: current };
      },
      [`DELETE /api/v1/orders/${ORDER_ID}`]: () => ({ status: 204 }),
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderApp(`/orders/${ORDER_ID}`);

    expect(await screen.findByRole("heading", { name: "demo_shop DEMO-1001" })).toBeInTheDocument();
    expect(screen.getByText("In Lamp parcel")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Lamp parcel/ })).toHaveAttribute(
      "href",
      `/parcels/${PARCEL_ID}`,
    );

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.type(screen.getByLabelText("Label"), "Kitchen{Enter}");
    expect(await screen.findByRole("heading", { name: "Kitchen" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Archive$/ }));
    expect(await screen.findByText(/You archived this order/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Delete/ }));
    expect(await screen.findByRole("heading", { name: "Orders" })).toBeInTheDocument();
    const writes = calls.filter((call) => call.method !== "GET").map((c) => [c.method, c.body]);
    expect(writes).toEqual([
      ["PATCH", { label: "Kitchen" }],
      ["PATCH", { archived: true }],
      ["DELETE", null],
    ]);
  });

  it("links a parcel to its order", async () => {
    mockApi({
      "GET /api/v1/session": () => ({ body: SIGNED_IN }),
      "GET /api/v1/carriers": () => ({ body: [] }),
      [`GET /api/v1/parcels/${PARCEL_ID}`]: () => ({
        body: parcel({
          id: PARCEL_ID,
          order: { id: ORDER_ID, shop: "demo_shop", order_number: "DEMO-1001", items: [] },
        }),
      }),
    });
    renderApp(`/parcels/${PARCEL_ID}`);
    expect(await screen.findByRole("link", { name: "demo_shop DEMO-1001" })).toHaveAttribute(
      "href",
      `/orders/${ORDER_ID}`,
    );
  });
});

describe("archive explanation", () => {
  it("says why an order is or is not archived", () => {
    expect(archiveExplanation(order())).toMatch(/once all its parcels are archived/);
    expect(archiveExplanation(order({ archived: true }))).toMatch(/all its parcels are archived/);
    expect(archiveExplanation(order({ archive_mode: "kept" }))).toMatch(/You restored/);
  });
});
