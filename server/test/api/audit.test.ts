import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/api/app.js";
import { loggerOptions } from "../../src/log/logger.js";
import { FakeWorld, fakePost, fakeVerify, VerifyWorld } from "../fakes/carriers.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

/* Regressions for the security and SSE audit. Every code, token and name is made up. */

let context: TestContext | undefined;
afterEach(async () => {
  await context?.close();
  context = undefined;
});

async function setUp(plugins = [fakePost(new FakeWorld())]) {
  context = await createTestContext({ plugins });
  const app = await context.app();
  const session = await signIn(context, app);
  return { context, app, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } };
}

describe("request log", () => {
  it("never writes the ICS token or the signed image id", async () => {
    const { context: ctx } = await setUp();
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino(loggerOptions("info"), sink);
    const app = await buildApp({ ...ctx.services, logger });
    const secretFeed = "madeupfeedtoken0123456789abcdef";
    const secretImage = "bWFkZS11cC1pbWFnZQ.c2lnbmF0dXJlLW1hZGUtdXA";
    await app.inject({ url: `/ical/${secretFeed}.ics?x=1` });
    await app.inject({ url: `/img/${secretImage}` });
    await app.close();
    const log = lines.join("");
    expect(log).toContain("/ical/:token.ics");
    expect(log).toContain("/img/:file");
    expect(log).not.toContain(secretFeed);
    expect(log).not.toContain(secretImage);
  });

  it("scrubs error messages and stacks", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    pino(loggerOptions("info"), sink).error(
      { err: new Error("Failed for someone@example.invalid code 00340434000000000099") },
      "x",
    );
    const log = lines.join("");
    expect(log).not.toContain("someone@example.invalid");
    expect(log).not.toContain("00340434000000000099");
  });
});

/** Reads SSE messages (those with an event name) until `count` arrived. */
async function readEvents(
  response: Response,
  count: number,
): Promise<{ id: string; event: string; data: unknown }[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("No body.");
  }
  const decoder = new TextDecoder();
  const messages: { id: string; event: string; data: unknown }[] = [];
  let buffer = "";
  while (messages.length < count) {
    const part = await reader.read();
    if (part.done) {
      break;
    }
    buffer += decoder.decode(part.value as Uint8Array, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const fields = Object.fromEntries(
        block
          .split("\n")
          .filter((line) => !line.startsWith(":") && line.includes(": "))
          .map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]),
      ) as Record<string, string>;
      if (fields["event"] !== undefined) {
        messages.push({
          id: fields["id"] ?? "",
          event: fields["event"],
          data: JSON.parse(fields["data"] ?? "null"),
        });
      }
    }
  }
  await reader.cancel();
  return messages;
}

describe("SSE replay", () => {
  async function stream(lastEventId: number) {
    const { context: ctx, app } = await setUp();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const base = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    const token = (await ctx.services.auth.createToken("sse", ["read"], null)).token;
    return {
      ctx,
      open: (id = lastEventId) =>
        fetch(`${base}/api/v1/events`, {
          headers: { authorization: `Bearer ${token}`, "last-event-id": String(id) },
        }),
    };
  }

  async function appendEvents(ctx: TestContext, count: number): Promise<void> {
    const rows = Array.from({ length: count }, (_, index) => ({
      type: "source.run_finished",
      parcel_id: null,
      payload: JSON.stringify({ n: index }),
      created_at: ctx.clock.now().toISOString(),
    }));
    for (let at = 0; at < rows.length; at += 500) {
      await ctx.services.db
        .insertInto("outbox")
        .values(rows.slice(at, at + 500))
        .execute();
    }
    await ctx.services.bus.notify();
  }

  it("pages past 1000 missed events and joins the live stream without a gap", async () => {
    const { ctx, open } = await stream(0);
    await appendEvents(ctx, 1500);
    const response = await open(0);
    const pending = readEvents(response, 1501);
    await appendEvents(ctx, 1);
    const messages = await pending;
    expect(messages).toHaveLength(1501);
    expect(messages.map((message) => Number(message.id))).toEqual(
      Array.from({ length: 1501 }, (_, index) => index + 1),
    );
  });

  it("sends resync for an id newer than any event and for one older than retention", async () => {
    const { ctx, open } = await stream(0);
    await appendEvents(ctx, 3);
    const [ahead] = await readEvents(await open(99), 1);
    expect(ahead).toEqual({ id: "3", event: "resync", data: { seq: 3, reason: "ahead" } });

    await ctx.services.db.deleteFrom("outbox").where("seq", "<=", 2).execute();
    const [stale] = await readEvents(await open(0), 1);
    expect(stale).toEqual({ id: "3", event: "resync", data: { seq: 3, reason: "expired" } });
    // Right at the edge of retention is still a normal replay.
    const [replayed] = await readEvents(await open(2), 1);
    expect(replayed).toMatchObject({ id: "3", event: "source.run_finished" });
  });
});

describe("manual sync", () => {
  it("is refused with 429 and Retry-After while the carrier's wait runs", async () => {
    const { context: ctx, app, headers } = await setUp();
    const source = await ctx.services.sources.create({
      plugin: "fakepost",
      kind: "tracking",
      label: "t",
      config: {},
      secret: null,
    });
    const until = new Date(ctx.clock.now().getTime() + 6 * 60 * 60_000).toISOString();
    await ctx.services.db
      .updateTable("sources")
      .set({ backoff_until: until, next_run_at: until })
      .where("id", "=", source.id)
      .execute();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/sources/${source.id}/sync`,
      headers,
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("21600");
    expect(response.json()).toMatchObject({
      error: "source_backing_off",
      message: expect.stringContaining("6 hours") as unknown,
    });
    const row = await ctx.services.sources.get(source.id);
    expect(row?.nextRunAt).toBe(until);

    ctx.clock.advance(6 * 60 * 60_000 + 1000);
    const later = await app.inject({
      method: "POST",
      url: `/api/v1/sources/${source.id}/sync`,
      headers,
    });
    expect(later.statusCode).toBe(202);
  });
});

describe("interactive sign-in under load", () => {
  async function toCodeStep() {
    const world = new VerifyWorld();
    const { context: ctx, app, headers } = await setUp([fakeVerify(world)]);
    const post = (url: string, payload: Record<string, unknown> = {}) =>
      app.inject({ method: "POST", url, headers, payload });
    const source = (
      await post("/api/v1/sources", { plugin: "fakeverify", kind: "account", label: "A" })
    ).json<{ id: string }>().id;
    const attempt = (await post(`/api/v1/sources/${source}/sign-in/attempts`)).json<{
      attempt_id: string;
    }>().attempt_id;
    const answer = (input: Record<string, string>) =>
      post(`/api/v1/sources/${source}/sign-in/attempts/${attempt}/continue`, { input });
    await answer({ username: "made-up-user", password: ["a", "b"].join("-") });
    await answer({ choice: "sms" });
    return { ctx, world, answer, attempt };
  }

  it("reaches the carrier once for a double submit of the same step", async () => {
    const { world, answer } = await toCodeStep();
    const before = world.continues;
    const results = await Promise.all([answer({ code: "123456" }), answer({ code: "123456" })]);
    expect(world.continues - before).toBe(1);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 400]);
  });

  it("maps a captcha to sign_in_captcha with Retry-After, not a failed try", async () => {
    const { ctx, answer, attempt } = await toCodeStep();
    const response = await answer({ code: "captcha" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "sign_in_captcha" });
    expect(response.headers["retry-after"]).toBe("900");
    const row = await ctx.services.db
      .selectFrom("sign_in_attempts")
      .select("failures")
      .where("id", "=", attempt)
      .executeTakeFirstOrThrow();
    expect(row.failures).toBe(0);
    expect((await answer({ code: "123456" })).statusCode).toBe(200);
  });
});
