import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoCarrier, demoShop } from "../../src/carriers/demo/index.js";
import type { Order } from "../../src/domain/order-lifecycle.js";
import { register } from "../../src/engine/registry.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

let context: TestContext;
let app: App;
let headers: Record<string, string>;
let shopSource: string;

beforeEach(async () => {
  context = await createTestContext({ plugins: [register(demoCarrier), register(demoShop)] });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  const source = await context.services.sources.create({
    plugin: "demo_shop",
    kind: "shop",
    label: "Demo shop",
    config: {},
    secret: null,
  });
  shopSource = source.id;
  await context.services.runner.run(source.id);
});
afterEach(async () => {
  await context.close();
});

async function list(view: string): Promise<Order[]> {
  const response = await app.inject({ url: `/api/v1/orders?view=${view}`, headers });
  expect(response.statusCode).toBe(200);
  return response.json<Order[]>();
}

async function demoOrder(): Promise<Order> {
  const order = (await list("all")).find((entry) => entry.order_number === "DEMO-1001");
  if (order === undefined) throw new Error("no demo order");
  return order;
}

async function outboxTypes(): Promise<string[]> {
  const rows = await context.services.db.selectFrom("outbox").select("type").execute();
  return rows.map((row) => row.type);
}

describe("orders API", () => {
  it("lists shop orders with items, parcels and a derived status", async () => {
    const order = await demoOrder();
    expect(order.parcel_count).toBe(order.parcels.length);
    expect(order.parcel_count).toBeGreaterThan(0);
    expect(order.items.map((item) => item.title)).toContain("Gift voucher, 20 EUR");
    expect(order.total?.currency).toBe("EUR");
    expect(order.archive_mode).toBe("automatic");
    expect(order.archived).toBe(false);
    expect(order.display_name).toBe(`${order.shop} DEMO-1001`);
    const one = await app.inject({ url: `/api/v1/orders/${order.id}`, headers });
    expect(one.json<Order>()).toEqual(order);
    const parcel = await app.inject({
      url: `/api/v1/parcels/${order.parcels[0]?.id ?? ""}`,
      headers,
    });
    expect(parcel.json<{ order: { id: string } }>().order.id).toBe(order.id);
  });

  it("archives automatically once every parcel is archived", async () => {
    const order = await demoOrder();
    for (const parcel of order.parcels) {
      await app.inject({
        method: "PATCH",
        url: `/api/v1/parcels/${parcel.id}`,
        headers,
        payload: { archived: true },
      });
    }
    const after = await demoOrder();
    expect(after.archived).toBe(true);
    expect(after.archive_mode).toBe("automatic");
    expect((await list("archived")).map((entry) => entry.id)).toContain(order.id);
    expect((await list("open")).map((entry) => entry.id)).not.toContain(order.id);
  });

  it("renames, archives by hand, keeps and returns to automatic", async () => {
    const order = await demoOrder();
    const patch = (payload: object) =>
      app.inject({ method: "PATCH", url: `/api/v1/orders/${order.id}`, headers, payload });

    const renamed = (await patch({ label: "Kitchen things" })).json<Order>();
    expect(renamed.display_name).toBe("Kitchen things");
    const archived = (await patch({ archived: true })).json<Order>();
    expect(archived).toMatchObject({ archived: true, archive_mode: "archived" });
    expect(archived.parcels.every((parcel) => parcel.archived_at === null)).toBe(true);
    expect((await patch({ archived: false })).json<Order>()).toMatchObject({
      archived: false,
      archive_mode: "kept",
    });
    expect((await patch({ archived: null, label: null })).json<Order>()).toMatchObject({
      archive_mode: "automatic",
      label: null,
    });
    expect(await outboxTypes()).toContain("order.updated");
  });

  it("deletes an order, keeps its parcels and does not bring it back on the next sync", async () => {
    const order = await demoOrder();
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/orders/${order.id}`,
      headers,
    });
    expect(removed.statusCode).toBe(204);
    expect(await outboxTypes()).toContain("order.deleted");
    const gone = await app.inject({ url: `/api/v1/orders/${order.id}`, headers });
    expect(gone.statusCode).toBe(404);

    const parcelId = order.parcels[0]?.id ?? "";
    const parcel = await app.inject({ url: `/api/v1/parcels/${parcelId}`, headers });
    expect(parcel.statusCode).toBe(200);
    expect(parcel.json<{ order: unknown }>().order).toBeNull();

    await context.services.runner.run(shopSource);
    expect((await list("all")).map((entry) => entry.order_number)).not.toContain("DEMO-1001");
    const again = await app.inject({ url: `/api/v1/parcels/${parcelId}`, headers });
    expect(again.json<{ order: unknown }>().order).toBeNull();
  });

  it("answers 404 for unknown orders", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    expect((await app.inject({ url: `/api/v1/orders/${id}`, headers })).statusCode).toBe(404);
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/orders/${id}`,
      headers,
      payload: { label: "x" },
    });
    expect(patched.statusCode).toBe(404);
  });
});
