import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { fakeVerify, VerifyWorld } from "../fakes/carriers.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

// Made-up values only; the typed password is assembled so it never reads as a literal credential.
const USER = "made-up-user";
const TYPED = ["not", "a", "real", "one"].join("-");

interface StepBody {
  status: "step" | "done";
  attempt_id: string;
  expires_at: string;
  step: { kind: string; [key: string]: unknown };
}

let context: TestContext;
let app: App;
let world: VerifyWorld;
let headers: Record<string, string>;

beforeEach(async () => {
  world = new VerifyWorld();
  context = await createTestContext({ plugins: [fakeVerify(world)] });
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
});

afterEach(async () => {
  await context.close();
});

async function newSource(config: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/sources",
    headers,
    payload: { plugin: "fakeverify", kind: "account", label: "Account", config },
  });
  return response.json<{ id: string }>().id;
}

function post(url: string, payload: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url,
    headers,
    payload,
  });
}

async function start(id: string, flow?: string): Promise<StepBody> {
  const response = await post(
    `/api/v1/sources/${id}/sign-in/attempts`,
    flow === undefined ? {} : { flow },
  );
  expect(response.statusCode).toBe(200);
  return response.json<StepBody>();
}

function answer(id: string, attempt: string, input: Record<string, string>) {
  return post(`/api/v1/sources/${id}/sign-in/attempts/${attempt}/continue`, { input });
}

/** Signs in through the form and picks a method; returns the attempt and its step. */
async function upToMethod(id: string, method: string): Promise<StepBody> {
  const first = await start(id);
  expect(first.step).toMatchObject({ kind: "form" });
  const chosen = await answer(id, first.attempt_id, { username: USER, password: TYPED });
  expect(chosen.json<StepBody>().step).toMatchObject({ kind: "choose_method" });
  const next = await answer(id, first.attempt_id, { choice: method });
  expect(next.statusCode).toBe(200);
  return next.json<StepBody>();
}

describe("interactive sign-in", () => {
  it("lists flows per kind and configuration, and in the carrier list", async () => {
    const a = await newSource();
    const b = await newSource({ variant: "b" });
    const flows = async (id: string) =>
      (await app.inject({ url: `/api/v1/sources/${id}/sign-in/flows`, headers }))
        .json<{ id: string }[]>()
        .map((flow) => flow.id);
    expect(await flows(a)).toEqual(["verify"]);
    expect(await flows(b)).toEqual(["verify", "variant_b"]);
    const carriers = (await app.inject({ url: "/api/v1/carriers", headers })).json<
      { sign_in: string; sign_in_flows: { id: string; conditional: boolean }[] }[]
    >();
    expect(carriers[0]?.sign_in).toBe("interactive");
    expect(carriers[0]?.sign_in_flows.map((flow) => [flow.id, flow.conditional])).toEqual([
      ["verify", false],
      ["variant_b", true],
      ["none", false],
    ]);
    const other = await start(b, "variant_b");
    expect(other.step).toEqual({ kind: "open_url", url: "https://b.example.invalid/" });
    const wrong = await post(`/api/v1/sources/${a}/sign-in/attempts`, { flow: "variant_b" });
    expect(wrong.json()).toMatchObject({ error: "no_sign_in" });
  });

  it("walks form, method choice and a texted code; a network error keeps the step", async () => {
    const id = await newSource();
    const otp = await upToMethod(id, "sms");
    expect(otp.step).toEqual({ kind: "otp_code", channel: "sms", destination: "+31 6 ** 01" });

    const unreachable = await answer(id, otp.attempt_id, { code: "net" });
    expect(unreachable.statusCode).toBe(503);
    expect(unreachable.json()).toMatchObject({ error: "sign_in_unavailable" });

    const refused = await answer(id, otp.attempt_id, { code: "000000" });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: "sign_in_refused" });

    const done = await answer(id, otp.attempt_id, { code: "123456" });
    expect(done.json()).toEqual({ status: "done" });
    // Neither the network error nor the refused code started the sign-in over.
    expect(world.starts).toBe(1);
    expect((await context.services.sources.get(id))?.hasSecret).toBe(true);
    const gone = await answer(id, otp.attempt_id, { code: "123456" });
    expect(gone.json()).toMatchObject({ error: "sign_in_expired" });
  });

  it("takes an emailed link or code", async () => {
    const id = await newSource();
    const link = await upToMethod(id, "email");
    expect(link.step).toEqual({ kind: "email_link", destination: "u***@example.invalid" });
    expect((await answer(id, link.attempt_id, { code: " 123456 " })).json()).toEqual({
      status: "done",
    });
  });

  it("checks the input against the step", async () => {
    const id = await newSource();
    const first = await start(id);
    const missing = await answer(id, first.attempt_id, { username: USER });
    expect(missing.json()).toMatchObject({ error: "sign_in_failed" });
    await answer(id, first.attempt_id, { username: USER, password: TYPED });
    const unknown = await answer(id, first.attempt_id, { choice: "pigeon" });
    expect(unknown.json()).toMatchObject({ error: "sign_in_failed" });
    expect(world.continues).toBe(1);
    const notWaiting = await post(
      `/api/v1/sources/${id}/sign-in/attempts/${first.attempt_id}/poll`,
    );
    expect(notWaiting.statusCode).toBe(409);
  });

  it("keeps the state encrypted and bound to its source", async () => {
    const id = await newSource();
    const other = await newSource();
    const first = await start(id);
    await answer(id, first.attempt_id, { username: USER, password: TYPED });
    const row = await context.services.db
      .selectFrom("sign_in_attempts")
      .select("blob")
      .executeTakeFirstOrThrow();
    expect(row.blob.toString("utf8")).not.toContain(USER);
    const elsewhere = await answer(other, first.attempt_id, { choice: "sms" });
    expect(elsewhere.json()).toMatchObject({ error: "sign_in_expired" });
  });

  it("drops tampered state", async () => {
    const id = await newSource();
    const first = await start(id);
    const row = await context.services.db
      .selectFrom("sign_in_attempts")
      .select("blob")
      .executeTakeFirstOrThrow();
    const damaged = Buffer.from(row.blob);
    damaged[damaged.length - 1] = (damaged.at(-1) ?? 0) ^ 0xff;
    await context.services.db.updateTable("sign_in_attempts").set({ blob: damaged }).execute();
    const response = await answer(id, first.attempt_id, { username: USER, password: TYPED });
    expect(response.json()).toMatchObject({ error: "sign_in_expired" });
    expect(world.continues).toBe(0);
    const left = await context.services.db.selectFrom("sign_in_attempts").selectAll().execute();
    expect(left).toEqual([]);
  });

  it("expires an unanswered step", async () => {
    const id = await newSource();
    const first = await start(id);
    context.clock.advance(16 * 60_000);
    const late = await answer(id, first.attempt_id, { username: USER, password: TYPED });
    expect(late.json()).toMatchObject({ error: "sign_in_expired" });
  });

  it("drops the attempt after too many refused codes", async () => {
    const id = await newSource();
    const otp = await upToMethod(id, "sms");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await answer(id, otp.attempt_id, { code: "1" })).json()).toMatchObject({
        error: "sign_in_refused",
      });
    }
    await answer(id, otp.attempt_id, { code: "1" });
    const after = await answer(id, otp.attempt_id, { code: "123456" });
    expect(after.json()).toMatchObject({ error: "sign_in_expired" });
  });

  it("polls an approval at the step's pace and finishes when approved", async () => {
    const id = await newSource();
    const waiting = await upToMethod(id, "app");
    expect(waiting.step).toEqual({
      kind: "await_approval",
      message: "Approve in the app.",
      poll_interval_seconds: 5,
      timeout_seconds: 60,
    });
    const url = `/api/v1/sources/${id}/sign-in/attempts/${waiting.attempt_id}/poll`;
    const early = await post(url);
    expect(early.statusCode).toBe(429);
    expect(early.headers["retry-after"]).toBe("5");
    expect(world.polls).toBe(0);

    world.approveOnPoll = 2;
    context.clock.advance(5_000);
    const still = await post(url);
    expect(still.json<StepBody>().step).toMatchObject({ kind: "await_approval" });
    // Waiting does not move the approval's deadline.
    expect(still.json<StepBody>().expires_at).toBe(waiting.expires_at);
    context.clock.advance(5_000);
    expect((await post(url)).json()).toEqual({ status: "done" });
  });

  it("times an approval out", async () => {
    const id = await newSource();
    const waiting = await upToMethod(id, "app");
    const url = `/api/v1/sources/${id}/sign-in/attempts/${waiting.attempt_id}/poll`;
    for (let poll = 0; poll < 3; poll += 1) {
      context.clock.advance(5_000);
      expect((await post(url)).statusCode).toBe(200);
    }
    context.clock.advance(60_000);
    const late = await post(url);
    expect(late.statusCode).toBe(400);
    expect(late.json()).toMatchObject({ error: "sign_in_timeout" });
    expect((await post(url)).json()).toMatchObject({ error: "sign_in_expired" });
  });

  it("cancels an attempt", async () => {
    const id = await newSource();
    const first = await start(id);
    const url = `/api/v1/sources/${id}/sign-in/attempts/${first.attempt_id}`;
    expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(404);
  });
});
