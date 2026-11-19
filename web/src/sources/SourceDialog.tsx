import { useMemo, useState, type SyntheticEvent, type ReactNode } from "react";
import { useAddSource, useCarriers, useUpdateSource } from "../api/queries";
import type { Carrier, Source } from "../api/types";
import { Dialog, ErrorNotice, Field } from "../components/ui";
import { MAIL_CONFIG_SCHEMA, MAIL_PLUGIN } from "./mail";
import { SchemaFields } from "./SchemaForm";
import { asSchema, cleanValues, initialValues, type FormValues, type JsonSchema } from "./schema";

type Kind = Source["kind"];

const KIND_LABELS: Readonly<Record<Kind, string>> = {
  account: "Account (your parcels from the carrier)",
  tracking: "Tracking (look up codes)",
  shop: "Shop (orders)",
  mail: "Mailbox",
};

function configSchema(plugin: string, carriers: readonly Carrier[]): JsonSchema {
  return plugin === MAIL_PLUGIN
    ? MAIL_CONFIG_SCHEMA
    : asSchema(carriers.find((c) => c.id === plugin)?.config_schema);
}

function kindsOf(plugin: string, carriers: readonly Carrier[]): Kind[] {
  return plugin === MAIL_PLUGIN
    ? ["mail"]
    : [...(carriers.find((c) => c.id === plugin)?.source_kinds ?? [])];
}

/** Adds a source (choose a carrier and kind first) or edits an existing one's label and config. */
export function SourceDialog(props: {
  readonly open: boolean;
  readonly editing: Source | null;
  readonly onClose: () => void;
  readonly onCreated: (source: Source) => void;
}): ReactNode {
  const carriers = useCarriers();
  const add = useAddSource();
  const update = useUpdateSource();
  const list = useMemo(
    () => [...(carriers.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [carriers.data],
  );
  const editing = props.editing;
  const [plugin, setPlugin] = useState(editing?.plugin ?? "");
  const kinds = kindsOf(plugin, list);
  const [kind, setKind] = useState<Kind | "">(editing?.kind ?? "");
  const effectiveKind = kind !== "" && kinds.includes(kind) ? kind : (kinds[0] ?? "");
  const schema = configSchema(plugin, list);
  const [label, setLabel] = useState(editing?.label ?? "");
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(configSchema(editing?.plugin ?? "", carriers.data ?? []), editing?.config),
  );
  const mutation = editing === null ? add : update;

  const choosePlugin = (next: string): void => {
    setPlugin(next);
    setKind("");
    setValues(initialValues(configSchema(next, list), undefined));
    const name = next === MAIL_PLUGIN ? "Mailbox" : list.find((c) => c.id === next)?.name;
    if (label === "" && name !== undefined) {
      setLabel(name);
    }
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    const config = cleanValues(schema, values);
    if (editing !== null) {
      update.mutate({ id: editing.id, body: { label, config } }, { onSuccess: props.onClose });
      return;
    }
    if (effectiveKind === "") {
      return;
    }
    add.mutate({ plugin, kind: effectiveKind, label, config }, { onSuccess: props.onCreated });
  };

  return (
    <Dialog
      title={editing === null ? "Add a source" : `Edit ${editing.label}`}
      open={props.open}
      onClose={props.onClose}
      wide
    >
      <form onSubmit={submit} className="stack">
        {editing === null ? (
          <>
            <Field label="Carrier, shop or mailbox">
              {(id) => (
                <select
                  id={id}
                  required
                  value={plugin}
                  onChange={(e) => {
                    choosePlugin(e.target.value);
                  }}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value={MAIL_PLUGIN}>Mailbox (IMAP)</option>
                  {list.map((carrier) => (
                    <option key={carrier.id} value={carrier.id}>
                      {carrier.name}
                      {carrier.countries.length > 0 ? ` (${carrier.countries.join(", ")})` : ""}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {kinds.length > 1 ? (
              <Field label="Kind">
                {(id) => (
                  <select
                    id={id}
                    value={effectiveKind}
                    onChange={(e) => {
                      setKind(e.target.value as Kind);
                    }}
                  >
                    {kinds.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            ) : null}
          </>
        ) : null}
        <Field label="Name">
          {(id) => (
            <input
              id={id}
              required
              maxLength={80}
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
            />
          )}
        </Field>
        {plugin === "" ? null : (
          <SchemaFields schema={schema} values={values} onChange={setValues} />
        )}
        {editing === null && plugin !== "" ? (
          <p className="muted">After adding it, sign in from the source list if it needs it.</p>
        ) : null}
        <ErrorNotice error={mutation.error} />
        <div className="actions">
          <button type="button" className="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={mutation.isPending || plugin === ""}
          >
            {editing === null ? "Add source" : "Save"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
