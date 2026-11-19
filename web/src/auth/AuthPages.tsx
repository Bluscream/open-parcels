import { useState, type SyntheticEvent, type ReactNode } from "react";
import { ErrorNotice, Field } from "../components/ui";
import { useSetup, useSignIn } from "./session";

const MIN_PASSWORD = 10;

interface AuthPageProps {
  /** Set when reading is open and this page was opened from the app: a way back to it. */
  readonly onCancel?: () => void;
}

function AuthCard(
  props: AuthPageProps & { readonly title: string; readonly children: ReactNode },
): ReactNode {
  return (
    <main className="auth-page">
      <section className="card auth-card" aria-labelledby="auth-title">
        <p className="brand">
          <img className="brand-logo" src="favicon.svg" alt="" />
          Open Parcels
        </p>
        <h1 id="auth-title">{props.title}</h1>
        {props.children}
        {props.onCancel === undefined ? null : (
          <button type="button" className="link-button" onClick={props.onCancel}>
            Back to the app (read only)
          </button>
        )}
      </section>
    </main>
  );
}

/** First start: the setup code from the container log, then the admin password. */
export function SetupPage(props: AuthPageProps): ReactNode {
  const setup = useSetup();
  const [setupCode, setSetupCode] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (password.length < MIN_PASSWORD) {
      setProblem(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== repeat) {
      setProblem("The passwords do not match.");
      return;
    }
    setProblem(null);
    setup.mutate({ setupCode: setupCode.trim(), password });
  };

  return (
    <AuthCard title="Set up open-parcels" {...props}>
      <p className="muted">
        This is the first start. Enter the setup code printed in the container log, then choose the
        admin password.
      </p>
      <form onSubmit={submit} className="stack">
        <Field label="Setup code" hint="Look for “enter the setup code” in the container log.">
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              autoComplete="one-time-code"
              required
              value={setupCode}
              onChange={(e) => {
                setSetupCode(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Admin password" hint={`At least ${MIN_PASSWORD} characters.`}>
          {(id, hint) => (
            <input
              id={id}
              type="password"
              aria-describedby={hint}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Repeat the password">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(e) => {
                setRepeat(e.target.value);
              }}
            />
          )}
        </Field>
        {problem === null ? null : (
          <p role="alert" className="notice notice-error">
            {problem}
          </p>
        )}
        <ErrorNotice error={setup.error} />
        <button type="submit" className="button primary" disabled={setup.isPending}>
          {setup.isPending ? "Saving…" : "Set password and continue"}
        </button>
      </form>
    </AuthCard>
  );
}

/** One box: the admin password signs in to change things, the reader password only to read. */
export function SignInPage(props: AuthPageProps): ReactNode {
  const signIn = useSignIn();
  const [password, setPassword] = useState("");

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    signIn.mutate(password, {
      onSettled: () => {
        setPassword("");
      },
    });
  };

  return (
    <AuthCard title="Sign in" {...props}>
      <form onSubmit={submit} className="stack">
        <Field
          label="Password"
          hint="The admin password to change things, or the reader password to read."
        >
          {(id, hint) => (
            <input
              id={id}
              aria-describedby={hint}
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />
          )}
        </Field>
        <ErrorNotice error={signIn.error} />
        <button type="submit" className="button primary" disabled={signIn.isPending}>
          {signIn.isPending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthCard>
  );
}
