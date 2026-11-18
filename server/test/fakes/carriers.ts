import { z } from "zod";
import { register, type RegisteredPlugin } from "../../src/engine/registry.js";
import {
  defineCarrier,
  pastedRedirect,
  SignInRejectedError,
  snapshot,
  TransientError,
  type FetchResult,
  type LiveReading,
  type ParcelSnapshot,
  type SnapshotEvent,
} from "../../src/plugin/api.js";

/**
 * A scripted carrier world for tests. Each run returns what the test put in `listing`, or throws
 * `failWith`. Calls are recorded so tests can check what the engine asked for.
 */
export class FakeWorld {
  listing: ParcelSnapshot[] = [];
  complete = true;
  failWith: Error | undefined;
  readonly accountCalls: number[] = [];
  readonly trackCalls: string[][] = [];
  readonly sessions: unknown[] = [];
  unknownToReport: string[] = [];
  /** Live readings returned one per call; `Error` entries are thrown. */
  liveScript: (LiveReading | null | Error)[] = [];
  readonly liveCalls: unknown[] = [];

  result(): FetchResult {
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return { snapshots: this.listing, complete: this.complete };
  }
}

const secretSchema = z.object({ username: z.string(), password: z.string() }).nullable();

/** A carrier with an account source and code tracking. */
export function fakePost(world: FakeWorld): RegisteredPlugin {
  return register(
    defineCarrier({
      id: "fakepost",
      name: "Fake Post",
      countries: ["DE"],
      sourceKinds: ["account", "tracking"],
      configSchema: z.looseObject({}),
      secretSchema,
      signIn: { type: "credentials" },
      http: { limits: { "*": { intervalMs: 1000, burst: 2 } } },
      async fetchAccount(context) {
        world.accountCalls.push(Date.now());
        world.sessions.push(context.session.load());
        await context.session.save({ token: `renewed-${world.accountCalls.length}` });
        for (const key of world.unknownToReport) {
          context.reportUnknown("status_code", key);
        }
        return Promise.resolve(world.result());
      },
      async track(_context, barcodes) {
        world.trackCalls.push([...barcodes]);
        const result = world.result();
        return Promise.resolve({
          ...result,
          snapshots: result.snapshots.filter((s) => barcodes.includes(s.barcode)),
        });
      },
    }),
  );
}

/** A shop whose parcels are either delivered by itself or handed to fakepost. */
export function fakeShop(world: FakeWorld): RegisteredPlugin {
  return register(
    defineCarrier({
      id: "fakeshop",
      name: "Fake Shop",
      countries: ["*"],
      sourceKinds: ["shop"],
      configSchema: z.looseObject({}),
      secretSchema: z.object({ refreshToken: z.string() }).nullable(),
      signIn: pastedRedirect<Record<string, unknown>, { refreshToken: string } | null>({
        start: () =>
          Promise.resolve({
            url: "https://shop.example.invalid/sign-in?state=s1",
            state: { nonce: "s1" },
          }),
        finish: (_context, state, pasted) => {
          const code = new URL(pasted).searchParams.get("code");
          if (code === null || (state as { nonce?: string }).nonce !== "s1") {
            return Promise.reject(new Error("bad paste"));
          }
          return Promise.resolve({ refreshToken: `rt-${code}` });
        },
      }),
      http: { limits: {} },
      async fetchAccount() {
        world.accountCalls.push(Date.now());
        return Promise.resolve(world.result());
      },
      async readLive(_context, target) {
        world.liveCalls.push(target.ref);
        const next = world.liveScript.shift() ?? null;
        if (next instanceof Error) {
          throw next;
        }
        return Promise.resolve(next);
      },
    }),
  );
}

/** Scripted state of the fake verifying carrier: how often each part ran, and what happens next. */
export class VerifyWorld {
  starts = 0;
  continues = 0;
  polls = 0;
  /** The poll that says "approved" (1-based); polls before it keep waiting. */
  approveOnPoll = Number.POSITIVE_INFINITY;
}

const verifyStateSchema = z.object({ user: z.string(), method: z.string().optional() });
const ACCEPTED_CODE = "123456";

function codeTurn(world: VerifyWorld, user: string, code: string | undefined) {
  if (code === "net") {
    return Promise.reject(new TransientError("The fake carrier is unreachable."));
  }
  if (code !== ACCEPTED_CODE) {
    return Promise.reject(new SignInRejectedError("Wrong code."));
  }
  return Promise.resolve({ secret: { token: `tok-${user}-${String(world.continues)}` } });
}

/**
 * A carrier whose account sign-in walks through every step kind: a form, a method choice, then a
 * texted code, an emailed link or an approval in an app. Variant "b" sources get a second flow.
 */
export function fakeVerify(world: VerifyWorld): RegisteredPlugin {
  const configSchema = z.looseObject({ variant: z.enum(["a", "b"]).optional() });
  return register(
    defineCarrier<z.infer<typeof configSchema>, { token: string } | null>({
      id: "fakeverify",
      name: "Fake Verify",
      countries: ["NL"],
      sourceKinds: ["account", "tracking"],
      configSchema,
      secretSchema: z.object({ token: z.string() }).nullable(),
      signIn: [
        {
          type: "interactive",
          id: "verify",
          label: "Sign in and verify",
          kinds: ["account"],
          start() {
            world.starts += 1;
            return Promise.resolve({
              step: {
                kind: "form",
                fields: [
                  { name: "username", label: "User", type: "text" },
                  { name: "password", label: "Password", type: "password" },
                ],
              },
              state: null,
            });
          },
          continue(_context, rawState, input) {
            world.continues += 1;
            if (rawState === null) {
              return Promise.resolve({
                step: {
                  kind: "choose_method",
                  options: [
                    { id: "sms", label: "Text message" },
                    { id: "email", label: "Email" },
                    { id: "app", label: "App" },
                  ],
                },
                state: { user: input["username"] ?? "" },
              });
            }
            const state = verifyStateSchema.parse(rawState);
            if (state.method === undefined) {
              const method = input["choice"] ?? "";
              const step =
                method === "sms"
                  ? {
                      kind: "otp_code" as const,
                      channel: "sms" as const,
                      destination: "+31 6 ** 01",
                    }
                  : method === "email"
                    ? { kind: "email_link" as const, destination: "u***@example.invalid" }
                    : {
                        kind: "await_approval" as const,
                        message: "Approve in the app.",
                        pollIntervalSeconds: 5,
                        timeoutSeconds: 60,
                      };
              return Promise.resolve({ step, state: { ...state, method } });
            }
            return codeTurn(world, state.user, input["code"]);
          },
          poll(_context, rawState) {
            world.polls += 1;
            const state = verifyStateSchema.parse(rawState);
            if (world.polls >= world.approveOnPoll) {
              return Promise.resolve({ secret: { token: `tok-${state.user}-app` } });
            }
            return Promise.resolve({
              step: {
                kind: "await_approval",
                message: "Still waiting.",
                pollIntervalSeconds: 5,
                timeoutSeconds: 60,
              },
              state,
            });
          },
        },
        {
          type: "interactive",
          id: "variant_b",
          label: "Variant B",
          kinds: ["account"],
          when: (config) => config.variant === "b",
          start: () =>
            Promise.resolve({
              step: { kind: "open_url", url: "https://b.example.invalid/" },
              state: 1,
            }),
          continue: () => Promise.resolve({ secret: { token: "tok-b" } }),
        },
        { type: "none", kinds: ["tracking"] },
      ],
      http: { limits: {} },
      fetchAccount: () => Promise.resolve({ snapshots: [], complete: true }),
    }),
  );
}

export function reading(
  state: LiveReading["state"],
  stopsAway: number | null,
  position: { latitude: number; longitude: number } | null = null,
): LiveReading {
  return {
    state,
    stopsAway,
    latitude: position?.latitude ?? null,
    longitude: position?.longitude ?? null,
    accuracy: position === null ? null : 10,
    positionAt: position === null ? null : "2026-11-18T14:00:00Z",
    message: stopsAway === null ? null : `${stopsAway} stops away`,
  };
}

export function scan(
  at: string,
  rawStatus: string,
  status: ParcelSnapshot["status"],
  location: string | null = null,
): SnapshotEvent {
  return { at, rawStatus, status, location };
}

export { snapshot };
