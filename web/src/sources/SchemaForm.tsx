import type { ReactNode } from "react";
import { Field } from "../components/ui";
import {
  fieldType,
  humanize,
  isSecretField,
  unwrap,
  type FormValues,
  type JsonSchema,
} from "./schema";

const MAX_DEPTH = 3;

interface FieldProps {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly required: boolean;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly depth: number;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function EnumInput(props: FieldProps & { readonly id: string; readonly hint?: string }): ReactNode {
  const options = unwrap(props.schema).enum ?? [];
  return (
    <select
      id={props.id}
      aria-describedby={props.hint}
      required={props.required}
      value={text(props.value)}
      onChange={(e) => {
        props.onChange(e.target.value === "" ? undefined : e.target.value);
      }}
    >
      {props.required ? null : <option value="">—</option>}
      {options.map((option) => (
        <option key={String(option)} value={String(option)}>
          {String(option)}
        </option>
      ))}
    </select>
  );
}

function ScalarField(props: FieldProps): ReactNode {
  const schema = unwrap(props.schema);
  const type = fieldType(schema);
  const label = schema.title ?? humanize(props.name);

  if (type === "boolean") {
    return (
      <label className="checkbox">
        <input
          type="checkbox"
          checked={props.value === true}
          onChange={(e) => {
            props.onChange(e.target.checked);
          }}
        />
        {label}
        {schema.description === undefined ? null : (
          <small className="hint"> — {schema.description}</small>
        )}
      </label>
    );
  }

  return (
    <Field
      label={props.required ? `${label} *` : label}
      {...(schema.description === undefined ? {} : { hint: schema.description })}
    >
      {(id, hint) => {
        if (type === "enum") {
          return <EnumInput {...props} id={id} {...(hint === undefined ? {} : { hint })} />;
        }
        if (type === "array") {
          return (
            <textarea
              id={id}
              aria-describedby={hint}
              rows={3}
              required={props.required}
              placeholder="One per line"
              value={Array.isArray(props.value) ? props.value.join("\n") : ""}
              onChange={(e) => {
                const lines = e.target.value.split("\n").map((line) => line.trim());
                props.onChange(lines.filter((line) => line !== ""));
              }}
            />
          );
        }
        const numeric = type === "number" || type === "integer";
        const secret = !numeric && isSecretField(props.name);
        return (
          <input
            id={id}
            aria-describedby={hint}
            type={
              numeric
                ? "number"
                : secret
                  ? "password"
                  : schema.format === "email"
                    ? "email"
                    : "text"
            }
            autoComplete={secret ? "off" : undefined}
            required={props.required}
            min={schema.minimum}
            max={schema.maximum}
            step={type === "integer" ? 1 : undefined}
            value={text(props.value)}
            onChange={(e) => {
              const raw = e.target.value;
              props.onChange(numeric ? (raw === "" ? undefined : Number(raw)) : raw);
            }}
          />
        );
      }}
    </Field>
  );
}

function SchemaField(props: FieldProps): ReactNode {
  const schema = unwrap(props.schema);
  if (fieldType(schema) === "object" && props.depth < MAX_DEPTH) {
    return (
      <fieldset className="nested">
        <legend>{schema.title ?? humanize(props.name)}</legend>
        <SchemaFields
          schema={schema}
          values={
            typeof props.value === "object" && props.value !== null
              ? (props.value as FormValues)
              : {}
          }
          onChange={props.onChange}
          depth={props.depth + 1}
        />
      </fieldset>
    );
  }
  return <ScalarField {...props} />;
}

export function SchemaFields(props: {
  readonly schema: JsonSchema;
  readonly values: FormValues;
  readonly onChange: (values: FormValues) => void;
  readonly depth?: number;
}): ReactNode {
  const required = new Set(props.schema.required ?? []);
  const entries = Object.entries(props.schema.properties ?? {});
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="stack">
      {entries.map(([name, property]) => (
        <SchemaField
          key={name}
          name={name}
          schema={property}
          required={required.has(name)}
          value={props.values[name]}
          depth={props.depth ?? 0}
          onChange={(value) => {
            props.onChange({ ...props.values, [name]: value });
          }}
        />
      ))}
    </div>
  );
}
