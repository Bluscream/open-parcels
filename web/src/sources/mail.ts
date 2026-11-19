import type { SignInFlow } from "../api/types";
import type { JsonSchema } from "./schema";

/** Mailboxes are not a carrier plug-in, so their forms mirror the server's mail schemas here. */
export const MAIL_PLUGIN = "imap";

export const MAIL_CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  required: ["host"],
  properties: {
    host: { type: "string", title: "IMAP server", description: "For example imap.example.org." },
    port: { type: "integer", minimum: 1, maximum: 65535, default: 993 },
    secure: { type: "boolean", title: "Use TLS", default: true },
    folders: { type: "array", items: { type: "string" }, default: ["INBOX"] },
    initialDays: {
      type: "integer",
      title: "Days to look back on the first sync",
      minimum: 1,
      maximum: 365,
      default: 30,
    },
  },
};

export const MAIL_SECRET_SCHEMA: JsonSchema = {
  type: "object",
  required: ["username", "password"],
  properties: {
    username: { type: "string", title: "User name" },
    password: { type: "string", title: "Password" },
  },
};

export const MAIL_FLOWS: SignInFlow[] = [
  {
    id: "credentials",
    label: "User name and password",
    type: "credentials",
    kinds: [],
    secret_schema: null,
    conditional: false,
  },
];
