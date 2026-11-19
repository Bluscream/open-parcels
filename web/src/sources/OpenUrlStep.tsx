import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import type { SignInStep } from "../api/types";
import { Field } from "../components/ui";
import { captureSignIn, EXTENSION_URL, useCompanionExtension } from "./extension";

type OpenUrl = Extract<SignInStep, { kind: "open_url" }>;

interface Props {
  readonly step: OpenUrl;
  readonly busy: boolean;
  readonly onSubmit: (input: Record<string, string>) => void;
}

/** One named window, so "Continue" reopens the sign-in where the user already is. */
const POPUP = "open-parcels-sign-in";
const POPUP_FEATURES = "popup,width=520,height=760";

function openPopup(url: string): void {
  window.open(url, POPUP, POPUP_FEATURES);
}

/** An app address (`dhllogin://…`) the browser cannot open, unlike a web page it lands on. */
function isAppAddress(prefix: string | null): boolean {
  return prefix !== null && !/^https?:/iu.test(prefix);
}

function isFirefox(): boolean {
  return /firefox|librewolf/iu.test(navigator.userAgent);
}

const CANCEL_REASONS: Readonly<Record<string, string>> = {
  closed: "The sign-in window was closed before it finished.",
  denied: "The extension was not allowed to help this page.",
  invalid: "The extension could not use this sign-in address.",
  timeout: "The sign-in took too long.",
};

/** Sign-in through the companion extension: it opens the window and brings the address back. */
function ExtensionSignIn(
  props: Props & { readonly onFallback: (reason: string) => void },
): ReactNode {
  const { step, onSubmit, onFallback } = props;
  const cancelRef = useRef<(() => void) | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => () => cancelRef.current?.(), []);
  const start = (): void => {
    const run = captureSignIn({
      url: step.url,
      redirectPrefix: step.redirect_prefix ?? "",
      resumeUrl: step.resume_url,
    });
    cancelRef.current = run.cancel;
    setWaiting(true);
    void run.result.then((outcome) => {
      cancelRef.current = null;
      setWaiting(false);
      if (outcome.status === "captured") {
        onSubmit({ pasted: outcome.url });
      } else {
        onFallback(CANCEL_REASONS[outcome.reason] ?? "The extension stopped.");
      }
    });
  };
  return (
    <div className="stack">
      {waiting ? (
        <p className="muted" role="status" aria-live="polite">
          <span className="pulse" aria-hidden="true" /> Sign in in the window that opened. It closes
          by itself when you are done.
        </p>
      ) : (
        <p>The extension opens the carrier&apos;s page; you sign in there as usual.</p>
      )}
      <div className="actions">
        <button
          type="button"
          className="button primary"
          disabled={waiting || props.busy}
          onClick={start}
        >
          {props.busy
            ? "Working…"
            : waiting
              ? "Waiting for sign-in…"
              : "Sign in with the extension"}
        </button>
      </div>
    </div>
  );
}

function ManualGuide({ step }: { readonly step: OpenUrl }): ReactNode {
  const app = isAppAddress(step.redirect_prefix);
  const firefox = isFirefox();
  const devtools = firefox
    ? "In that window, press F12, open Network and tick “Persist Logs”."
    : "In that window, press F12, open Network and tick “Preserve log”.";
  return (
    <ol className="steps">
      <li>
        <button
          type="button"
          className="button"
          onClick={() => {
            openPopup(step.url);
          }}
        >
          Open the sign-in page
        </button>{" "}
        in a new window.
      </li>
      {app ? <li>{devtools}</li> : null}
      <li>Sign in, including any code the carrier sends you.</li>
      {step.resume_url === null ? null : (
        <li>
          Page stays white after signing in?{" "}
          <button
            type="button"
            className="button"
            onClick={() => {
              if (step.resume_url !== null) openPopup(step.resume_url);
            }}
          >
            Continue the sign-in
          </button>{" "}
          (no new password needed).
        </li>
      )}
      {app ? (
        <li>
          In the Network list, click the last row with status <strong>302</strong> (usually{" "}
          <code>authorize</code>). Under Response Headers, copy the value of{" "}
          <strong>Location</strong>; it starts with <code>{step.redirect_prefix}</code>.
          {firefox ? " If an error page appears instead, its address works too." : ""}
        </li>
      ) : (
        <li>
          When the window lands on the final page, copy its full address from the address bar.
        </li>
      )}
      <li>Paste it below. Extra text around it is fine.</li>
    </ol>
  );
}

function PasteForm({ busy, onSubmit }: Pick<Props, "busy" | "onSubmit">): ReactNode {
  const [pasted, setPasted] = useState("");
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    onSubmit({ pasted: pasted.trim() });
    setPasted("");
  };
  return (
    <form onSubmit={submit} className="stack">
      <Field label="Final address">
        {(id) => (
          <input
            id={id}
            type="text"
            required
            autoComplete="off"
            spellCheck={false}
            value={pasted}
            onChange={(e) => {
              setPasted(e.target.value);
            }}
          />
        )}
      </Field>
      <div className="actions">
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "Working…" : "Continue"}
        </button>
      </div>
    </form>
  );
}

/**
 * "Sign in in your browser": with the companion extension in one click, or by hand with a guide
 * that fits the browser and the kind of final address.
 */
export function OpenUrlStep(props: Props): ReactNode {
  const { step } = props;
  const extension = useCompanionExtension();
  const usable = step.redirect_prefix !== null;
  const [mode, setMode] = useState<"extension" | "manual" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const chosen = mode ?? (usable && extension.version !== null ? "extension" : null);

  return (
    <div className="stack">
      {step.message === undefined ? null : <p className="step-message">{step.message}</p>}
      {notice === null ? null : (
        <p className="notice" role="status">
          {notice} You can try again or do it step by step.
        </p>
      )}
      {usable ? (
        <fieldset>
          <legend>How do you want to sign in?</legend>
          <label className="checkbox">
            <input
              type="radio"
              name="sign-in-way"
              checked={chosen === "extension"}
              disabled={extension.version === null}
              onChange={() => {
                setMode("extension");
              }}
            />
            With the open-parcels extension (recommended)
            {extension.checked && extension.version === null ? (
              <span className="muted">
                {" "}
                — not installed.{" "}
                <a href={EXTENSION_URL} target="_blank" rel="noreferrer noopener">
                  Get it
                </a>{" "}
                for Firefox, Chrome, Edge and Brave, then reload this page.
              </span>
            ) : null}
          </label>
          <label className="checkbox">
            <input
              type="radio"
              name="sign-in-way"
              checked={chosen === "manual"}
              onChange={() => {
                setMode("manual");
              }}
            />
            Step by step, by hand
          </label>
        </fieldset>
      ) : null}
      {chosen === "extension" ? (
        <ExtensionSignIn
          {...props}
          onFallback={(reason) => {
            setNotice(reason);
          }}
        />
      ) : null}
      {chosen === "manual" || !usable ? (
        <>
          <ManualGuide step={step} />
          <PasteForm busy={props.busy} onSubmit={props.onSubmit} />
        </>
      ) : null}
    </div>
  );
}
