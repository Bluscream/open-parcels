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

  // The shapes the audit found stored whole: senders and receivers by name, postcodes, phone
  // numbers, and the InPost Italy inbox's locker codes nested under its pick-up.
  it.each([
    ["InPost Italy", { pickUp: { qrCode: "QR-1", openCode: "123456" }, status: "READY" }],
    [
      "sender and consignor",
      { sender: { representativeName: "A" }, consignor: "B", status: "READY" },
    ],
    ["contact details", { customer: { telephone: "0", postalCode: "0000" }, status: "READY" }],
    ["PostNL-like", { shipFrom: { name: "A" }, receiver: { name: "B" }, status: "READY" }],
  ])("drops the personal data and codes of %s", (_name, payload) => {
    const scrubbed = JSON.stringify(scrubRaw(payload));
    for (const leaked of ["QR-1", "123456", "representativeName", "consignor", "telephone"]) {
      expect(scrubbed).not.toContain(leaked);
    }
    expect(scrubbed).toContain("READY");
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
