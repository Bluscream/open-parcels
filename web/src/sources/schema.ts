/**
 * The small part of JSON Schema that carrier config and sign-in schemas use (zod's output):
 * objects of strings, numbers, booleans, enums, string lists and nested objects.
 */
export interface JsonSchema {
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly items?: JsonSchema;
  readonly default?: unknown;
  readonly description?: string;
  readonly title?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly anyOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
}

export type FormValues = Record<string, unknown>;

export function asSchema(value: unknown): JsonSchema {
  return typeof value === "object" && value !== null ? value : {};
}

/** Field names that hold secrets render as password inputs. */
const SECRET_NAME = /pass|secret|token|key|pin|code/i;

export function isSecretField(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** `["string","null"]` and `anyOf: [X, {type: null}]` both mean "X, optional". */
export function unwrap(schema: JsonSchema): JsonSchema {
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants !== undefined) {
    const real = variants.filter((variant) => variant.type !== "null");
    if (real.length === 1 && real[0] !== undefined) {
      return {
        ...real[0],
        ...(schema.description === undefined ? {} : { description: schema.description }),
      };
    }
    const consts = variants.filter((variant) => variant.const !== undefined);
    if (consts.length === variants.length) {
      return { ...schema, type: "string", enum: consts.map((variant) => variant.const) };
    }
  }
  if (Array.isArray(schema.type)) {
    const types = (schema.type as readonly string[]).filter((type) => type !== "null");
    return { ...schema, type: types[0] ?? "string" };
  }
  return schema;
}

export function fieldType(schema: JsonSchema): string {
  const plain = unwrap(schema);
  if (plain.enum !== undefined) {
    return "enum";
  }
  return typeof plain.type === "string" ? plain.type : "string";
}

/** Starting values: the stored config when editing, otherwise the schema defaults. */
export function initialValues(schema: JsonSchema, current: unknown): FormValues {
  const existing = typeof current === "object" && current !== null ? (current as FormValues) : {};
  const values: FormValues = { ...existing };
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    const plain = unwrap(property);
    if (existing[name] !== undefined) {
      continue;
    }
    if (plain.default !== undefined) {
      values[name] = plain.default;
    } else if (fieldType(plain) === "object") {
      values[name] = initialValues(plain, undefined);
    }
  }
  return values;
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && value !== null && Object.keys(value).length === 0)
  );
}

/** Drops empty optional fields so the server applies its own defaults; keeps fields the form does not show. */
export function cleanValues(schema: JsonSchema, values: FormValues): FormValues {
  const required = new Set(schema.required ?? []);
  const shown = schema.properties ?? {};
  const result: FormValues = Object.fromEntries(
    Object.entries(values).filter(([name]) => !(name in shown)),
  );
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    let value = values[name];
    if (fieldType(property) === "object" && typeof value === "object" && value !== null) {
      value = cleanValues(unwrap(property), value as FormValues);
    }
    if (!isEmpty(value) || required.has(name)) {
      result[name] = value;
    }
  }
  return result;
}

/** A readable label from a field name: `trackingLinks` → "Tracking links". */
export function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
