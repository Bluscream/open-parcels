/**
 * Errors a carrier plug-in throws to tell the scheduler what happened. Anything else counts as a
 * transient failure. The distinction matters: only `SignInRejectedError` may lead to a new
 * sign-in, and only once; a network error never does.
 */

export class PluginError extends Error {
  override readonly name: string = "PluginError";
}

/** The carrier refused the stored credentials or session. The source needs the user to sign in again. */
export class SignInRejectedError extends PluginError {
  override readonly name = "SignInRejectedError";
}

/** The carrier asked us to slow down (HTTP 429, or 503 with Retry-After). */
export class RateLimitedError extends PluginError {
  override readonly name = "RateLimitedError";

  constructor(
    message: string,
    /** Seconds the carrier asked us to wait, when it said so. */
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(message);
  }
}

/** The carrier put a captcha in front of us. We never try to solve it; we pause the source instead. */
export class CaptchaError extends PluginError {
  override readonly name = "CaptchaError";
}

/**
 * The source's settings cannot work (a required postcode is missing, say). Nothing is retried
 * until the user changes them; the source shows the message.
 */
export class InvalidConfigError extends PluginError {
  override readonly name = "InvalidConfigError";
}

/** A temporary failure: network error, timeout, 5xx, unexpected page. Retried with backoff. */
export class TransientError extends PluginError {
  override readonly name: string = "TransientError";
}

/** The response did not have the shape we expect. Logged with keys only, never values. */
export class UnexpectedResponseError extends TransientError {
  override readonly name = "UnexpectedResponseError";
}
