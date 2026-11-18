import { z } from "zod";
import {
  carrierPattern,
  carrierKey,
  defineCarrier,
  SignInRejectedError,
  TransientError,
  UnexpectedResponseError,
  type ParcelSnapshot,
  type PluginContext,
} from "../../plugin/api.js";
import { readAccount } from "./account.js";
import { TokenKeeper } from "./auth.js";
import { CARRIER_ID, scanSnapshot } from "./scans.js";
import { API_BASE, API_HOST, AUTH_HOST, getJson, parcelOf, resultOf, text } from "./shared.js";

const BARCODE = carrierPattern("posta_slovenije");

const configSchema = z.object({});
/** Tracking sources need nothing; account sources store the MojaPošta username and password. */
const secretSchema = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .nullable();
type Config = z.infer<typeof configSchema>;
type Secret = z.infer<typeof secretSchema>;

const reporter =
  (context: PluginContext<Config, Secret>) =>
  (code: string): void => {
    context.reportUnknown("status_code", code);
  };

async function track(context: PluginContext<Config, Secret>, barcodes: readonly string[]) {
  const snapshots: ParcelSnapshot[] = [];
  for (const barcode of barcodes) {
    if (!BARCODE.test(barcode)) {
      continue;
    }
    const url = new URL(`${API_BASE}/track/`);
    url.searchParams.set("TrackingNumber", barcode);
    const answer = await getJson(context.http, url);
    const notFound =
      answer.status === 404 &&
      text(answer.payload?.["errorCode"]) === "error.not.found" &&
      (text(answer.payload?.["errorMessage"]) ?? "").includes(barcode);
    if (notFound) {
      continue;
    }
    if (answer.status !== 200) {
      throw new TransientError(`Pošta Slovenije tracking answered HTTP ${answer.status}.`);
    }
    const result = resultOf(answer);
    const answered = (text(parcelOf(result)["trackingNumber"]) ?? "").toUpperCase();
    if (answered !== barcode.toUpperCase()) {
      throw new UnexpectedResponseError("Pošta Slovenije answered for a different parcel.");
    }
    snapshots.push(
      scanSnapshot(
        {
          barcode,
          statuses: result["statuses"],
          direction: "incoming",
          sender: null,
          receiver: null,
          raw: answer.payload,
        },
        reporter(context),
      ),
    );
  }
  return { snapshots, complete: true };
}

async function fetchAccount(context: PluginContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("The MojaPošta account needs a username and password.");
  }
  const keeper = new TokenKeeper(context.http, context.clock, context.session, context.secret);
  const snapshots = await readAccount(context.http, keeper, reporter(context));
  return { snapshots, complete: true };
}

/** Pošta Slovenije: the public lookup and the MojaPošta account. */
export const postaSlovenije = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "Pošta Slovenije",
  countries: ["SI"],
  sourceKinds: ["account", "tracking"],
  configSchema,
  secretSchema,
  signIn: { type: "credentials" },
  http: {
    limits: {
      [API_HOST]: { intervalMs: 4_000, burst: 2 },
      [AUTH_HOST]: { intervalMs: 30_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
    userAgent: {
      value: carrierKey(CARRIER_ID, "user_agent"),
      reason:
        "The service guards its API by client and answers error.not.allowed to unknown ones; the app's User-Agent is the one it accepts.",
    },
  },
  track,
  fetchAccount,
});
