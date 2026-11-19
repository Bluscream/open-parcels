import { describe, expect, it } from "vitest";
import {
  inView,
  orderArchivedAt,
  orderStatus,
  orderTotal,
  type ParcelState,
} from "../../src/domain/order-lifecycle.js";

function parcel(
  status: ParcelState["status"],
  delivered = status === "delivered",
  archived_at: string | null = null,
): ParcelState {
  return { status, delivered, archived_at };
}

describe("order status", () => {
  it.each([
    [[], "ordered"],
    [[parcel("registered"), parcel("unknown")], "ordered"],
    [[parcel("registered"), parcel("in_transit")], "partly_shipped"],
    [[parcel("in_transit"), parcel("at_pickup_point")], "shipped"],
    [[parcel("delivered"), parcel("registered")], "partly_delivered"],
    [[parcel("delivered"), parcel("delivered")], "delivered"],
    [[parcel("delivered"), parcel("returning")], "problem"],
    [[parcel("problem"), parcel("in_transit")], "problem"],
  ] as const)("%j is %s", (parcels, expected) => {
    expect(orderStatus(parcels)).toBe(expected);
  });

  it("does not count a problem on a delivered parcel", () => {
    // A manual "delivered" wins: the parcel is delivered even though the carrier said problem.
    expect(orderStatus([parcel("problem", true)])).toBe("delivered");
  });
});

describe("order archiving", () => {
  const archived = (at: string) => parcel("delivered", true, at);

  it("follows the parcels: archived when the last one was", () => {
    expect(orderArchivedAt(null, null, [archived("2026-01-02"), archived("2026-01-05")])).toBe(
      "2026-01-05",
    );
    expect(orderArchivedAt(null, null, [archived("2026-01-02"), parcel("delivered")])).toBeNull();
    expect(orderArchivedAt(null, null, [])).toBeNull();
  });

  it("archives an order that never got a parcel 30 days after it was placed", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    expect(orderArchivedAt(null, null, [], "2026-01-01T00:00:00Z", now)).toBe(
      "2026-01-31T00:00:00.000Z",
    );
    expect(orderArchivedAt(null, null, [], "2026-02-15T00:00:00Z", now)).toBeNull();
    expect(orderArchivedAt("kept", null, [], "2026-01-01T00:00:00Z", now)).toBeNull();
  });

  it("lets the owner's choice win", () => {
    expect(orderArchivedAt("archived", "2026-02-01", [parcel("in_transit")])).toBe("2026-02-01");
    expect(orderArchivedAt("kept", null, [archived("2026-01-02")])).toBeNull();
  });

  it("sorts orders into views", () => {
    expect(inView("open", "shipped", false)).toBe(true);
    expect(inView("open", "delivered", false)).toBe(false);
    expect(inView("delivered", "delivered", false)).toBe(true);
    expect(inView("delivered", "delivered", true)).toBe(false);
    expect(inView("archived", "shipped", true)).toBe(true);
    expect(inView("all", "ordered", true)).toBe(true);
  });
});

describe("order total", () => {
  it("adds priced lines in one currency, quantity included", () => {
    expect(
      orderTotal([
        { price: 9.99, quantity: 2, currency: "EUR" },
        { price: 0.1, quantity: null, currency: "EUR" },
        { price: null, quantity: 1, currency: null },
      ]),
    ).toEqual({ amount: 20.08, currency: "EUR" });
  });

  it("gives none for mixed currencies or no prices", () => {
    expect(
      orderTotal([
        { price: 1, quantity: 1, currency: "EUR" },
        { price: 1, quantity: 1, currency: "USD" },
      ]),
    ).toBeNull();
    expect(orderTotal([])).toBeNull();
  });
});
