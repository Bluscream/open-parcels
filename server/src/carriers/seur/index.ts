import { z } from "zod";
import { defineCarrier, SignInRejectedError, type PluginContext } from "../../plugin/api.js";
import { readInbox, SSO_HOST, WEB_HOST } from "./account.js";
import { CARRIER_ID, shipmentSnapshot } from "./parse.js";

const configSchema = z.looseObject({});
type Config = z.infer<typeof configSchema>;

/** The miSEUR email and password, stored encrypted. */
const secretSchema = z
  .object({ username: z.string().min(1), password: z.string().min(1) })
  .nullable();
type Secret = z.infer<typeof secretSchema>;

async function fetchAccount(context: PluginContext<Config, Secret>) {
  if (context.secret === null) {
    throw new SignInRejectedError("The SEUR account needs an email and password.");
  }
  const lists = await readInbox(context.http, context.session, context.secret, context.logger);
  const report = (code: string): void => {
    context.reportUnknown("status_code", code);
  };
  const read = [
    ...lists.incoming.map((raw) => shipmentSnapshot(raw, "incoming", report)),
    ...lists.outgoing.map((raw) => shipmentSnapshot(raw, "outgoing", report)),
  ];
  const snapshots = read.filter((parcel) => parcel !== null);
  // A shipment that could not be read is left out, so the list is no longer everything.
  return { snapshots, complete: lists.complete && snapshots.length === read.length };
}

export const seur = defineCarrier<Config, Secret>({
  id: CARRIER_ID,
  name: "SEUR",
  countries: ["ES"],
  sourceKinds: ["account"],
  configSchema,
  secretSchema,
  signIn: { type: "credentials" },
  http: {
    limits: {
      [SSO_HOST]: { intervalMs: 30_000, burst: 1 },
      [WEB_HOST]: { intervalMs: 10_000, burst: 2 },
      "*": { intervalMs: 10_000, burst: 1 },
    },
  },
  fetchAccount,
});
