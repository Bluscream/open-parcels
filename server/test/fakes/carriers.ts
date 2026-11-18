import { z } from "zod";
import { register, type RegisteredPlugin } from "../../src/engine/registry.js";
import {
  defineCarrier,
  snapshot,
  type FetchResult,
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
      secretSchema: z.null(),
      signIn: { type: "none" },
      http: { limits: {} },
      async fetchAccount() {
        world.accountCalls.push(Date.now());
        return Promise.resolve(world.result());
      },
    }),
  );
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
