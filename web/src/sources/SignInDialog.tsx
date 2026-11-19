import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type SyntheticEvent, type ReactNode } from "react";
import { getApiV1SourcesIdSignInFlows, putApiV1SourcesIdSecret } from "../api/generated";
import { keys, useCarriers } from "../api/queries";
import type { SignInFlow, Source } from "../api/types";
import { Dialog, ErrorNotice, Spinner } from "../components/ui";
import { MAIL_FLOWS, MAIL_PLUGIN, MAIL_SECRET_SCHEMA } from "./mail";
import { SchemaFields } from "./SchemaForm";
import { asSchema, cleanValues, type FormValues } from "./schema";
import { StepRenderer } from "./StepRenderer";
import { useSignInAttempt } from "./useSignInAttempt";

/** Credentials and API keys: a form from the carrier's sign-in schema, sent once with PUT. */
function StaticSecretForm(props: {
  readonly source: Source;
  readonly onDone: () => void;
}): ReactNode {
  const carriers = useCarriers();
  const client = useQueryClient();
  const schema =
    props.source.plugin === MAIL_PLUGIN
      ? MAIL_SECRET_SCHEMA
      : asSchema(carriers.data?.find((c) => c.id === props.source.plugin)?.secret_schema);
  const [values, setValues] = useState<FormValues>({});
  const save = useMutation({
    mutationFn: (secret: FormValues) => putApiV1SourcesIdSecret(props.source.id, { secret }),
    onSuccess: async () => {
      setValues({});
      await client.invalidateQueries({ queryKey: keys.sources });
      props.onDone();
    },
  });
  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    save.mutate(cleanValues(schema, values));
  };
  return (
    <form onSubmit={submit} className="stack" autoComplete="off">
      <SchemaFields schema={schema} values={values} onChange={setValues} />
      <ErrorNotice error={save.error} />
      <div className="actions">
        <button type="submit" className="button primary" disabled={save.isPending}>
          Save sign-in
        </button>
      </div>
    </form>
  );
}

function InteractiveSignIn(props: {
  readonly source: Source;
  readonly flow: SignInFlow;
  readonly onDone: () => void;
}): ReactNode {
  const attempt = useSignInAttempt(props.source.id);
  const { state } = attempt;
  if (state.phase === "done") {
    return (
      <div className="stack">
        <p className="notice" role="status">
          Signed in. The source runs now.
        </p>
        <div className="actions">
          <button type="button" className="button primary" onClick={props.onDone}>
            Close
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <ErrorNotice error={attempt.error} />
      {state.phase === "idle" ? (
        <div className="actions">
          <button
            type="button"
            className="button primary"
            disabled={attempt.busy}
            onClick={() => {
              void attempt.start(props.flow.id);
            }}
          >
            {attempt.busy ? "Starting…" : `Start: ${props.flow.label}`}
          </button>
        </div>
      ) : (
        <>
          <StepRenderer
            step={state.attempt.step}
            busy={attempt.busy}
            onSubmit={(input) => {
              void attempt.answer(input);
            }}
          />
          <div className="actions">
            <button type="button" className="button" onClick={attempt.cancel}>
              Cancel sign-in
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function FlowBody(props: {
  readonly source: Source;
  readonly flow: SignInFlow;
  readonly onDone: () => void;
}): ReactNode {
  switch (props.flow.type) {
    case "none":
      return <p className="muted">This source needs no sign-in.</p>;
    case "credentials":
    case "api_key":
      return <StaticSecretForm source={props.source} onDone={props.onDone} />;
    case "interactive":
      return <InteractiveSignIn key={props.flow.id} {...props} />;
  }
}

export function SignInDialog(props: {
  readonly source: Source | null;
  readonly onClose: () => void;
}): ReactNode {
  const source = props.source;
  const isMail = source?.plugin === MAIL_PLUGIN;
  const flows = useQuery({
    queryKey: ["sign-in-flows", source?.id],
    queryFn: ({ signal }) =>
      source === null || isMail
        ? Promise.resolve(MAIL_FLOWS)
        : getApiV1SourcesIdSignInFlows(source.id, { signal }),
    enabled: source !== null,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const list = flows.data ?? [];
  const flow = list.find((f) => f.id === chosen) ?? list[0];

  return (
    <Dialog
      title={source === null ? "Sign in" : `Sign in: ${source.label}`}
      open={source !== null}
      onClose={() => {
        setChosen(null);
        props.onClose();
      }}
      wide
    >
      <ErrorNotice error={flows.error} />
      {flows.isPending ? <Spinner /> : null}
      {list.length > 1 ? (
        <label className="field">
          <span>Sign-in method</span>
          <select
            value={flow?.id ?? ""}
            onChange={(e) => {
              setChosen(e.target.value);
            }}
          >
            {list.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {source === null || flow === undefined ? null : (
        <FlowBody source={source} flow={flow} onDone={props.onClose} />
      )}
    </Dialog>
  );
}
