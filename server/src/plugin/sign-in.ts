import type { Clock } from "../clock.js";
import type { PluginHttp } from "./http.js";

/** Source kinds a sign-in flow can apply to (mirrors `SOURCE_KINDS` in the plug-in API). */
export type SignInSourceKind = "account" | "tracking" | "shop";

/** One input on a form step. Typed values are never echoed back to the client. */
export interface SignInField {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "email" | "password" | "tel";
}

export interface SignInOption {
  readonly id: string;
  readonly label: string;
}

/**
 * What the UI shows next. Each kind fixes the input `continue` receives:
 * - `form`: one value per field, keyed by field name;
 * - `open_url`: `pasted`, the address the user's browser ended on;
 * - `email_link`: `code`, the link from the email or the code in it;
 * - `otp_code`: `code`, a code sent by SMS, email or an authenticator app;
 * - `choose_method`: `choice`, one of the option ids;
 * - `await_approval`: no input; the UI polls until the user approved on another device.
 */
export type SignInStep =
  | { readonly kind: "form"; readonly fields: readonly SignInField[]; readonly message?: string }
  | { readonly kind: "open_url"; readonly url: string; readonly message?: string }
  | {
      readonly kind: "email_link";
      /** Masked address the link went to, when the carrier says. */
      readonly destination: string | null;
      readonly message?: string;
    }
  | {
      readonly kind: "otp_code";
      readonly channel: "sms" | "email" | "app" | "other";
      readonly destination: string | null;
      readonly message?: string;
    }
  | {
      readonly kind: "choose_method";
      readonly options: readonly SignInOption[];
      readonly message?: string;
    }
  | {
      readonly kind: "await_approval";
      readonly message: string;
      /** The poll endpoint refuses calls closer together than this. */
      readonly pollIntervalSeconds: number;
      /** After this the attempt fails and the user starts again. */
      readonly timeoutSeconds: number;
    };

export type SignInStepKind = SignInStep["kind"];

/** What the user answered. Keys depend on the step kind; see {@link SignInStep}. */
export type SignInInput = Readonly<Record<string, string>>;

/**
 * The result of one sign-in call: the next step with the state to keep for it, or the finished
 * sign-in data. `state` is stored encrypted on the server and handed back on the next call; it may
 * hold cookies, PKCE verifiers or a typed password, and is never logged or sent to the client.
 */
export type SignInTurn<Secret> =
  { readonly step: SignInStep; readonly state: unknown } | { readonly secret: Secret };

export interface SignInContext<Config> {
  readonly config: Config;
  readonly kind: SignInSourceKind;
  /** Rate-limited like every other request of the plug-in. */
  readonly http: PluginHttp;
  readonly clock: Clock;
}

/** Restricts a flow to some source kinds or configurations. Both default to "always". */
export interface SignInScope<Config> {
  readonly kinds?: readonly SignInSourceKind[];
  when?(config: Config): boolean;
}

/** Sign-in data typed into the generic secret form, or nothing at all. */
export interface StaticSignIn<Config> extends SignInScope<Config> {
  readonly type: "none" | "credentials" | "api_key";
  readonly id?: string;
  readonly label?: string;
}

/**
 * A multi-step sign-in driven by the server: `start` and `continue` may call the carrier.
 *
 * Errors mean:
 * - `SignInRejectedError`: the carrier refused what the user entered (a wrong code). The attempt
 *   stays, so the user can try again on the same step;
 * - `TransientError`/`RateLimitedError`: the carrier could not be reached. The attempt stays
 *   unchanged and is never restarted on its own;
 * - anything else: the attempt stays too, but counts as a failed try.
 */
export interface InteractiveSignIn<Config, Secret> extends SignInScope<Config> {
  readonly type: "interactive";
  readonly id: string;
  readonly label: string;
  start(context: SignInContext<Config>): Promise<SignInTurn<Secret>>;
  continue(
    context: SignInContext<Config>,
    state: unknown,
    input: SignInInput,
  ): Promise<SignInTurn<Secret>>;
  /** Required when the flow can return an `await_approval` step. */
  poll?(context: SignInContext<Config>, state: unknown): Promise<SignInTurn<Secret>>;
}

export type SignInFlow<Config, Secret> = StaticSignIn<Config> | InteractiveSignIn<Config, Secret>;

/**
 * The classic "sign in in your own browser, paste the final address back" flow as an interactive
 * flow with one `open_url` step.
 */
export function pastedRedirect<Config, Secret>(options: {
  readonly id?: string;
  readonly label?: string;
  readonly kinds?: readonly SignInSourceKind[];
  readonly when?: (config: Config) => boolean;
  readonly message?: string;
  start(context: SignInContext<Config>): Promise<{ url: string; state: unknown }>;
  finish(context: SignInContext<Config>, state: unknown, pasted: string): Promise<Secret>;
}): InteractiveSignIn<Config, Secret> {
  return {
    type: "interactive",
    id: options.id ?? "pasted_redirect",
    label: options.label ?? "Sign in in your browser",
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    ...(options.when === undefined ? {} : { when: options.when }),
    async start(context) {
      const { url, state } = await options.start(context);
      const step: SignInStep = {
        kind: "open_url",
        url,
        message:
          options.message ??
          "Open the address, sign in, and paste the full address your browser ends on.",
      };
      return { step, state };
    },
    async continue(context, state, input) {
      return { secret: await options.finish(context, state, input["pasted"] ?? "") };
    },
  };
}
