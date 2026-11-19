/** Friendly names for the generated API types. */
import type {
  GetApiV1Calendar200Item,
  GetApiV1Carriers200Item,
  GetApiV1Parcels200Item,
  GetApiV1ParcelsId200,
  GetApiV1Session200,
  GetApiV1Sources200Item,
  GetApiV1SourcesIdSignInFlows200Item,
  GetApiV1Tokens200Item,
  PostApiV1SourcesIdSignInAttemptsAttemptContinue200,
} from "./generated";

export type Session = GetApiV1Session200;
export type Parcel = GetApiV1Parcels200Item;
export type ParcelDetail = GetApiV1ParcelsId200;
export type ParcelStatus = Parcel["status"];
export type LookupState = Parcel["lookup"]["state"];
export type Carrier = GetApiV1Carriers200Item;
export type Source = GetApiV1Sources200Item;
export type SourceState = Source["state"];
export type SignInFlow = GetApiV1SourcesIdSignInFlows200Item;
export type SignInResult = PostApiV1SourcesIdSignInAttemptsAttemptContinue200;
export type SignInStepResult = Extract<SignInResult, { status: "step" }>;
export type SignInStep = SignInStepResult["step"];
export type ApiToken = GetApiV1Tokens200Item;
export type CalendarEntry = GetApiV1Calendar200Item;

export const PARCEL_STATUSES: readonly ParcelStatus[] = [
  "registered",
  "in_transit",
  "out_for_delivery",
  "at_pickup_point",
  "delivered",
  "returning",
  "problem",
  "unknown",
];
