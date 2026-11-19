import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/fetcher";
import {
  deleteApiV1SourcesIdSignInAttemptsAttempt,
  postApiV1SourcesIdSignInAttempts,
  postApiV1SourcesIdSignInAttemptsAttemptContinue,
  postApiV1SourcesIdSignInAttemptsAttemptPoll,
} from "../api/generated";
import { keys } from "../api/queries";
import type { SignInResult, SignInStepResult } from "../api/types";
import type { StepInput } from "./StepRenderer";

export type AttemptState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "step";
      readonly attempt: SignInStepResult;
      /** Counts the steps of the attempt, so a step's form starts empty even when it repeats. */
      readonly seq: number;
    }
  | { readonly phase: "done" };

/**
 * Errors after which the attempt is gone and must be started again. A refused or failed answer
 * (a mistyped code) is not one of them: the server keeps the step, so the user can try again
 * without a new sign-in and possibly a new SMS. Too many tries end the attempt, and the next
 * answer then says so with `sign_in_expired`.
 */
const TERMINAL = new Set(["sign_in_expired", "sign_in_timeout"]);

/**
 * Drives one interactive sign-in: start, answer steps, poll approval steps at the server's
 * interval, cancel. Inputs are passed straight to the API and never kept.
 */
export function useSignInAttempt(sourceId: string) {
  const client = useQueryClient();
  const [state, setState] = useState<AttemptState>({ phase: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const attemptRef = useRef<string | null>(null);

  const apply = useCallback(
    (result: SignInResult): void => {
      if (result.status === "done") {
        attemptRef.current = null;
        setState({ phase: "done" });
        void client.invalidateQueries({ queryKey: keys.sources });
      } else {
        attemptRef.current = result.attempt_id;
        setState((previous) => ({
          phase: "step",
          attempt: result,
          seq: previous.phase === "step" ? previous.seq + 1 : 0,
        }));
      }
    },
    [client],
  );

  const run = useCallback(
    async (call: () => Promise<SignInResult>): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        apply(await call());
      } catch (caught) {
        setError(caught);
        if (caught instanceof ApiError && TERMINAL.has(caught.code)) {
          attemptRef.current = null;
          setState({ phase: "idle" });
        }
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const start = useCallback(
    (flow: string) => run(() => postApiV1SourcesIdSignInAttempts(sourceId, { flow })),
    [run, sourceId],
  );

  const answer = useCallback(
    (input: StepInput) => {
      const attempt = attemptRef.current;
      if (attempt === null) {
        return Promise.resolve();
      }
      return run(() =>
        postApiV1SourcesIdSignInAttemptsAttemptContinue(sourceId, attempt, { input }),
      );
    },
    [run, sourceId],
  );

  const cancel = useCallback(() => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    setState({ phase: "idle" });
    setError(null);
    if (attempt !== null) {
      deleteApiV1SourcesIdSignInAttemptsAttempt(sourceId, attempt).catch(() => undefined);
    }
  }, [sourceId]);

  // Closing the dialog unmounts the sign-in: the attempt left open is cancelled on the server too.
  useEffect(
    () => () => {
      const attempt = attemptRef.current;
      attemptRef.current = null;
      if (attempt !== null) {
        deleteApiV1SourcesIdSignInAttemptsAttempt(sourceId, attempt).catch(() => undefined);
      }
    },
    [sourceId],
  );

  // Approval steps: ask the server at its own interval until the step changes.
  const step = state.phase === "step" ? state.attempt.step : null;
  const interval = step?.kind === "await_approval" ? step.poll_interval_seconds : null;
  useEffect(() => {
    if (interval === null) {
      return undefined;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (delaySeconds: number): void => {
      timer = setTimeout(() => {
        const attempt = attemptRef.current;
        if (stopped || attempt === null) {
          return;
        }
        postApiV1SourcesIdSignInAttemptsAttemptPoll(sourceId, attempt).then(
          (result) => {
            if (stopped) {
              return;
            }
            const unchanged = result.status === "step" && result.step.kind === "await_approval";
            apply(result);
            if (unchanged) {
              poll(interval);
            }
          },
          (caught: unknown) => {
            if (stopped) {
              return;
            }
            if (caught instanceof ApiError && caught.code === "sign_in_poll_too_soon") {
              poll(caught.retryAfterSeconds ?? interval);
              return;
            }
            if (caught instanceof ApiError && caught.code === "sign_in_unavailable") {
              setError(caught);
              poll(interval * 2);
              return;
            }
            if (caught instanceof ApiError && caught.code === "sign_in_captcha") {
              // The attempt is kept; show why and try once the carrier's wait is over.
              setError(caught);
              poll(caught.retryAfterSeconds ?? interval * 2);
              return;
            }
            setError(caught);
            attemptRef.current = null;
            setState({ phase: "idle" });
          },
        );
      }, delaySeconds * 1000);
    };
    poll(interval);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [interval, sourceId, apply]);

  return { state, busy, error, start, answer, cancel };
}
