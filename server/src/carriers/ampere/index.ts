import { z } from "zod";
import {
  asObject,
  defineCarrier,
  SignInRejectedError,
  type FetchResult,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { ampereSnapshot, CARRIER_ID } from "./page.js";
import {
  DeadLinkError,
  deliveryWindow,
  exchange,
  HOST,
  parcelPage,
  storedSession,
  type GuestSession,
} from "./session.js";

/**
 * Ampère delivers for bol.com. There is no account: each parcel has a tracking link in the
 * shipping e-mail, which mints a guest session for that one parcel. The links are the secret;
 * the sessions they mint are kept in the source's session store, keyed by link.
 */
const configSchema = z.looseObject({});
const secretSchema = z.object({
  trackingLinks: z
    .array(z.url())
    .min(1)
    .describe("The tracking links from bol.com's shipping e-mails, one per parcel."),
});
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;
type Context = PluginContext<Config, Secret>;

/** Reads one parcel; a refused session is replaced once by following its link again. */
async function readParcel(
  context: Context,
  link: string,
  known: GuestSession | null,
): Promise<{ parcel: ParcelSnapshot; session: GuestSession }> {
  let session = known;
  let html = known === null ? null : await parcelPage(context.http, known);
  if (html === null) {
    ({ session, html } = await exchange(context.http, link));
  }
  if (html === null || session === null) {
    throw new DeadLinkError("Ampère refused the session a tracking link just created.");
  }
  const window = await deliveryWindow(context.http, session);
  const parcel = ampereSnapshot(
    { html, parcelToken: session.parcelToken, window, now: context.clock.now() },
    (value) => {
      context.reportUnknown("status_text", value);
    },
  );
  return { parcel, session };
}

/** Like `readParcel`, but a dead link yields null instead of failing the whole run. */
async function readLink(
  context: Context,
  link: string,
  known: GuestSession | null,
): Promise<{ parcel: ParcelSnapshot; session: GuestSession } | null> {
  try {
    return await readParcel(context, link, known);
  } catch (error) {
    if (!(error instanceof DeadLinkError)) {
      throw error;
    }
    context.logger.warn({}, "An Ampère tracking link no longer works; it can be removed.");
    return null;
  }
}

async function fetchAccount(context: Context): Promise<FetchResult> {
  const stored = asObject(context.session.load());
  const sessions: Record<string, GuestSession> = {};
  const snapshots: ParcelSnapshot[] = [];
  let dead = 0;
  try {
    // One link at a time; a network error or rate limit stops the run before more go out.
    for (const link of context.secret.trackingLinks) {
      const read = await readLink(context, link, storedSession(stored[link]));
      if (read === null) {
        dead += 1;
        continue;
      }
      snapshots.push(read.parcel);
      sessions[link] = read.session;
    }
  } finally {
    // Sessions that worked are kept even when a later link fails.
    const kept = Object.fromEntries(
      context.secret.trackingLinks
        .filter((link) => link in sessions || storedSession(stored[link]) !== null)
        .map((link) => [link, sessions[link] ?? storedSession(stored[link])]),
    );
    await context.session.save(kept);
  }
  if (dead === context.secret.trackingLinks.length) {
    throw new SignInRejectedError("None of the Ampère tracking links works any more.");
  }
  return { snapshots, complete: dead === 0 };
}

export const ampere = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Ampère",
  countries: ["NL"],
  sourceKinds: ["account"],
  configSchema,
  secretSchema,
  signIn: { type: "api_key" },
  http: {
    limits: {
      [HOST]: { intervalMs: 5_000, burst: 2 },
      "link.bol.com": { intervalMs: 10_000, burst: 1 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
});
