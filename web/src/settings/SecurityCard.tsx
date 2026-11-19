import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode, type SyntheticEvent } from "react";
import {
  SESSION_KEY,
  useChangeAdminPassword,
  useResetAdminPassword,
  useSession,
} from "../auth/session";
import { ErrorNotice, Field } from "../components/ui";
import {
  SOURCE_LABELS,
  useResetServerSetting,
  useSaveServerSetting,
  type ServerSetting,
} from "./server-settings";

const ADMIN_KEY = "OPENPARCELS_ADMIN_PASSWORD";
const READER_KEY = "OPENPARCELS_PASSWORD";
const MIN_ADMIN_PASSWORD = 10;

function PasswordInput(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: "current-password" | "new-password";
  readonly required?: boolean;
  readonly hint?: string;
}): ReactNode {
  return (
    <Field label={props.label} {...(props.hint === undefined ? {} : { hint: props.hint })}>
      {(id, hint) => (
        <input
          id={id}
          type="password"
          aria-describedby={hint}
          autoComplete={props.autoComplete}
          required={props.required ?? true}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
          }}
        />
      )}
    </Field>
  );
}

function AdminPassword({ setting }: { readonly setting: ServerSetting | undefined }): ReactNode {
  const ingress = useSession().data?.method === "ingress";
  const change = useChangeAdminPassword();
  const reset = useResetAdminPassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (next.length < MIN_ADMIN_PASSWORD) {
      setProblem(`Use at least ${MIN_ADMIN_PASSWORD} characters.`);
      return;
    }
    if (next !== repeat) {
      setProblem("The new passwords do not match.");
      return;
    }
    setProblem(null);
    change.mutate({ current: ingress && current === "" ? null : current, next });
  };

  return (
    <div className="stack">
      <h3>Admin password</h3>
      <p className="muted">
        Needed to change anything. Currently{" "}
        {setting === undefined ? "unknown" : SOURCE_LABELS[setting.source]}
        {setting?.source === "override" ? " (stored hashed)" : ""}. Changing or resetting it signs
        everyone out, you included.
      </p>
      <form className="stack" onSubmit={submit}>
        <PasswordInput
          label="Current admin password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          required={!ingress}
          {...(ingress ? { hint: "Not needed through Home Assistant." } : {})}
        />
        <PasswordInput
          label="New admin password"
          hint={`At least ${MIN_ADMIN_PASSWORD} characters.`}
          value={next}
          onChange={setNext}
          autoComplete="new-password"
        />
        <PasswordInput
          label="Repeat the new password"
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
        />
        {problem === null ? null : (
          <p role="alert" className="notice notice-error">
            {problem}
          </p>
        )}
        <ErrorNotice error={change.error ?? reset.error} />
        <div className="actions">
          <button type="submit" className="button primary" disabled={change.isPending}>
            {change.isPending ? "Saving…" : "Change admin password"}
          </button>
          {setting?.source === "override" ? (
            <button
              type="button"
              className="button"
              disabled={reset.isPending}
              title="Back to OPENPARCELS_ADMIN_PASSWORD from the environment"
              onClick={() => {
                if (
                  window.confirm(
                    "Use the environment's admin password again? Everyone is signed out.",
                  )
                ) {
                  reset.mutate();
                }
              }}
            >
              Reset to environment
            </button>
          ) : null}
        </div>
      </form>
    </div>
  );
}

function ReaderPassword({ setting }: { readonly setting: ServerSetting | undefined }): ReactNode {
  const client = useQueryClient();
  const save = useSaveServerSetting();
  const reset = useResetServerSetting();
  const [next, setNext] = useState("");
  const set = setting?.set === true;
  const refreshSession = (): void => {
    void client.invalidateQueries({ queryKey: SESSION_KEY });
  };
  const store = (value: string): void => {
    save.mutate(
      { key: READER_KEY, value },
      {
        onSuccess: () => {
          setNext("");
          refreshSession();
        },
      },
    );
  };

  return (
    <div className="stack">
      <h3>Reader password</h3>
      <p className="muted">
        {set
          ? "Set: reading needs a sign-in with this password (or the admin password)."
          : "Not set: anyone who can reach the server can read everything, but not change it."}{" "}
        Changing it signs readers out.
      </p>
      <form
        className="setting-edit"
        onSubmit={(event) => {
          event.preventDefault();
          if (next !== "") store(next);
        }}
      >
        <input
          type="password"
          aria-label="New reader password"
          placeholder={set ? "set; type to replace" : "unset"}
          autoComplete="new-password"
          value={next}
          onChange={(e) => {
            setNext(e.target.value);
          }}
        />
        <button type="submit" className="button primary" disabled={save.isPending || next === ""}>
          {set ? "Change" : "Set"}
        </button>
        {set ? (
          <button
            type="button"
            className="button"
            disabled={save.isPending}
            onClick={() => {
              if (window.confirm("Let anyone who can reach the server read without a password?")) {
                store("");
              }
            }}
          >
            Clear
          </button>
        ) : null}
        {setting?.source === "override" ? (
          <button
            type="button"
            className="button"
            disabled={reset.isPending}
            title="Back to OPENPARCELS_PASSWORD from the environment"
            onClick={() => {
              reset.mutate(READER_KEY, { onSuccess: refreshSession });
            }}
          >
            Reset
          </button>
        ) : null}
      </form>
      <ErrorNotice error={save.error ?? reset.error} />
    </div>
  );
}

/** The two passwords; admin only. */
export function SecurityCard({
  settings,
}: {
  readonly settings: readonly ServerSetting[];
}): ReactNode {
  return (
    <section className="card stack" aria-labelledby="settings-security">
      <h2 id="settings-security">Security</h2>
      <AdminPassword setting={settings.find((s) => s.key === ADMIN_KEY)} />
      <ReaderPassword setting={settings.find((s) => s.key === READER_KEY)} />
    </section>
  );
}
