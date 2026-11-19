import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotItem } from "../../src/plugin/api.js";
import { FakeWorld, fakePost, fakeShop, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Items of a parcel two sources report. Every title and code is made up. */

let context: TestContext;
let post: FakeWorld;
let shop: FakeWorld;

beforeEach(async () => {
  post = new FakeWorld();
  shop = new FakeWorld();
  context = await createTestContext({ plugins: [fakePost(post), fakeShop(shop)] });
});
afterEach(async () => {
  await context.close();
});

const item = (title: string, imageUrl: string | null, price: number | null): SnapshotItem => ({
  title,
  imageUrl,
  url: null,
  externalId: null,
  quantity: 1,
  price,
  currency: price === null ? null : "EUR",
});

describe("items reported by two sources", () => {
  it("stay the shop's, without flip-flopping when a plainer source reports the parcel", async () => {
    const parcel = { carrier: "fakeshop", barcode: "SHOP0001", status: null, rawStatus: null };
    shop.listing = [
      snapshot({
        ...parcel,
        items: [item("Example kettle", "https://img.example.invalid/k.jpg", 19.99)],
      }),
    ];
    post.listing = [snapshot({ ...parcel, items: [item("Kettle", null, null)] })];
    const shopSource = await context.services.sources.create({
      plugin: "fakeshop",
      kind: "shop",
      label: "shop",
      config: {},
      secret: { refreshToken: ["r", "t"].join("-") },
    });
    const other = await context.services.sources.create({
      plugin: "fakepost",
      kind: "account",
      label: "account",
      config: {},
      secret: { username: "user@example.invalid", password: ["p", "q"].join("-") },
    });
    const titles = async () =>
      (await context.services.db.selectFrom("items").select(["title", "price"]).execute()).map(
        (row) => [row.title, row.price],
      );
    for (let round = 0; round < 2; round += 1) {
      await context.services.runner.run(shopSource.id);
      expect(await titles()).toEqual([["Example kettle", 19.99]]);
      await context.services.runner.run(other.id);
      expect(await titles()).toEqual([["Example kettle", 19.99]]);
    }
  });

  it("are filled by any source while the parcel has none", async () => {
    post.listing = [
      snapshot({
        carrier: "fakepost",
        barcode: "FP0000000001",
        status: null,
        rawStatus: null,
        items: [item("Kettle", null, null)],
      }),
    ];
    const other = await context.services.sources.create({
      plugin: "fakepost",
      kind: "account",
      label: "account",
      config: {},
      secret: { username: "user@example.invalid", password: ["p", "q"].join("-") },
    });
    await context.services.runner.run(other.id);
    const rows = await context.services.db.selectFrom("items").select("title").execute();
    expect(rows).toEqual([{ title: "Kettle" }]);
  });
});
