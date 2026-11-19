import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubRaw, scrubStoredRaw } from "../../src/engine/raw-scrub.js";
import { FakeWorld, fakePost, snapshot } from "../fakes/carriers.js";
import { createTestContext, type TestContext } from "../helpers.js";

/* Stored raw payloads. Every name, address and code here is made up. */

const PERSONAL = {
  status: "DELIVERED",
  signedBy: "A. Example",
  recipient: { name: "A. Example", address: { street: "Example Street 1", city: "Testtown" } },
  events: [{ code: "DL", location: "Testtown", latitude: 52.123456, pickup_code: "1234" }],
};

const KEPT = { status: "DELIVERED", events: [{ code: "DL", location: "Testtown" }] };

describe("a stored raw payload", () => {
  it("keeps the carrier's data but no codes, names, addresses or coordinates", () => {
    expect(scrubRaw(PERSONAL)).toEqual(KEPT);
  });

  describe("in the database", () => {
    let context: TestContext;
    let post: FakeWorld;

    beforeEach(async () => {
      post = new FakeWorld();
      context = await createTestContext({ plugins: [fakePost(post)] });
    });
    afterEach(async () => {
      await context.close();
    });

    it("is scrubbed when written and, for older rows, at startup", async () => {
      post.listing = [
        snapshot({
          carrier: "fakepost",
          barcode: "FP0000000077",
          status: "delivered",
          rawStatus: "x",
          raw: PERSONAL,
        }),
      ];
      const source = await context.services.sources.create({
        plugin: "fakepost",
        kind: "account",
        label: "account",
        config: {},
        secret: { username: "user@example.invalid", password: ["p", "q"].join("-") },
      });
      await context.services.runner.run(source.id);
      const read = async () =>
        JSON.parse(
          (
            await context.services.db
              .selectFrom("parcel_raw")
              .select("payload")
              .executeTakeFirstOrThrow()
          ).payload,
        ) as unknown;
      expect(await read()).toEqual(KEPT);

      // As an older version stored it.
      await context.services.db
        .updateTable("parcel_raw")
        .set({ payload: JSON.stringify(PERSONAL) })
        .execute();
      expect(await scrubStoredRaw(context.services.db)).toBe(1);
      expect(await scrubStoredRaw(context.services.db)).toBe(0);
      expect(await read()).toEqual(KEPT);
    });
  });
});
