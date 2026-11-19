import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { demoCarrier, demoShop } from "../../src/carriers/demo/index.js";
import { register } from "../../src/engine/registry.js";
import { gridFor } from "../../src/images/collage.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/* Pictures are made up on the spot; no network is used. */

let context: TestContext;
let app: App;
let headers: Record<string, string>;

/** A small PNG in one colour, standing in for a shop's item picture. */
async function png(): Promise<Buffer> {
  return sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();
}

beforeEach(async () => {
  const picture = await png();
  context = await createTestContext({
    plugins: [register(demoCarrier), register(demoShop)],
    fetchImpl: () =>
      Promise.resolve(new Response(picture, { headers: { "content-type": "image/png" } })),
  });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  for (const plugin of ["demo_shop", "demo"] as const) {
    const source = await context.services.sources.create({
      plugin,
      kind: plugin === "demo" ? "account" : "shop",
      label: plugin,
      config: {},
      secret: null,
    });
    await context.services.runner.run(source.id);
  }
});
afterEach(async () => {
  await context.close();
});

interface ParcelBody {
  id: string;
  barcode: string;
  display_name: string;
  items: { title: string }[];
  order: { order_number: string; items: { title: string; parcel_id: string | null }[] } | null;
}

async function parcel(barcode: string): Promise<ParcelBody> {
  const list = (await app.inject({ url: "/api/v1/parcels?limit=50", headers })).json<
    ParcelBody[] | { items: ParcelBody[] }
  >();
  const found = (Array.isArray(list) ? list : list.items).find((p) => p.barcode === barcode);
  if (found === undefined) throw new Error(`no ${barcode}`);
  return (await app.inject({ url: `/api/v1/parcels/${found.id}`, headers })).json<ParcelBody>();
}

describe("items on orders and parcels", () => {
  it("lists the whole order, links lines to their parcel and keeps unplaced ones on the order", async () => {
    const lamp = await parcel("DEMO0000000002");
    expect(lamp.items.map((item) => item.title)).toEqual(["Desk lamp"]);
    expect(lamp.order?.order_number).toBe("DEMO-1001");
    const lines = lamp.order?.items ?? [];
    expect(lines.map((line) => line.title)).toEqual([
      "Coffee mug, blue",
      "Tea towel",
      "Desk lamp",
      "Gift voucher, 20 EUR",
    ]);
    expect(lines.find((line) => line.title === "Desk lamp")?.parcel_id).toBe(lamp.id);
    expect(lines.find((line) => line.title === "Gift voucher, 20 EUR")?.parcel_id).toBeNull();
  });

  it("names parcels after their items when asked, else by their tracking code", async () => {
    expect((await parcel("DEMO0000000001")).display_name).toBe("DEMO0000000001");
    const put = await app.inject({
      method: "PUT",
      url: "/api/v1/settings/parcel-label",
      headers,
      payload: { parcel_label: "items" },
    });
    expect(put.json()).toMatchObject({ parcel_label: "items" });
    expect((await parcel("DEMO0000000001")).display_name).toBe("Coffee mug, blue, Tea towel");
    const settings = await context.services.db
      .selectFrom("outbox")
      .select("type")
      .where("type", "=", "settings.updated")
      .execute();
    expect(settings).toHaveLength(1);
  });

  it("draws the item pictures as one square picture", async () => {
    const mugs = await parcel("DEMO0000000001");
    const picture = await app.inject({ url: `/api/v1/parcels/${mugs.id}/picture`, headers });
    expect(picture.statusCode).toBe(200);
    expect(picture.headers["content-type"]).toBe("image/png");
    const meta = await sharp(picture.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([256, 256]);
  });
});

describe("gridFor", () => {
  it.each([
    [1, 1],
    [2, 2],
    [4, 2],
    [5, 3],
    [9, 3],
    [12, 3],
  ])("puts %i pictures in a %i×%i grid", (count, columns) => {
    expect(gridFor(count)).toBe(columns);
  });
});
