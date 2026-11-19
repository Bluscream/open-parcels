import { z } from "zod";
import type { ParcelSnapshot } from "../plugin/snapshot.js";

/** Plug-in id of mailbox sources. Mail is handled by the core, not by a carrier plug-in. */
export const MAIL_PLUGIN = "imap";

export const mailConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  folders: z.array(z.string().min(1).max(200)).min(1).max(20).default(["INBOX"]),
  /** How far back the first sync looks. */
  initialDays: z.number().int().min(1).max(365).default(30),
});
export type MailConfig = z.infer<typeof mailConfigSchema>;

export const mailSecretSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type MailSecret = z.infer<typeof mailSecretSchema>;

/**
 * The default name of a mailbox source: the account, so two mailboxes on one server differ.
 * A username that is already an address keeps its own domain and names the server after it.
 */
export function mailboxLabel(username: string, host: string): string {
  return username.includes("@") ? `Mailbox ${username} (${host})` : `Mailbox ${username}@${host}`;
}

/** True for the names older versions gave mailboxes by default, which hid the account. */
export function isGenericMailboxLabel(label: string, host: string): boolean {
  return label === "Mailbox" || label === `Mailbox ${host}`;
}

/** Progress per folder, kept in the encrypted session store. */
export const mailProgressSchema = z.record(
  z.string(),
  z.object({ uidValidity: z.string(), lastUid: z.number().int().nonnegative() }),
);
export type MailProgress = z.infer<typeof mailProgressSchema>;

/** A received mail, already decoded. Never logged: it is personal data. */
export interface MailInput {
  readonly messageId: string | null;
  readonly from: string;
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly date: Date | null;
}

/**
 * Turns a mail into parcel snapshots. The rules come from the shared rules package; the watcher
 * itself knows nothing about carriers.
 */
export type MailInterpreter = (mail: MailInput) => readonly ParcelSnapshot[];

export interface FetchedMessage {
  readonly uid: number;
  /** The raw RFC 822 message. */
  readonly source: Buffer;
  /** When the server received it (IMAP INTERNALDATE), if it said. */
  readonly receivedAt?: Date | null;
}

/** What the watcher needs from an IMAP connection; the real one wraps imapflow, tests use a fake. */
export interface MailboxClient {
  connect(): Promise<void>;
  /** Opens a folder read-only and returns its UIDVALIDITY. */
  open(folder: string): Promise<{ uidValidity: string }>;
  /** UIDs of messages received on or after `since`. */
  searchSince(since: Date): Promise<number[]>;
  /** Messages with a UID above `afterUid`, oldest first. */
  fetchAfter(afterUid: number): AsyncIterable<FetchedMessage>;
  fetchUids(uids: readonly number[]): AsyncIterable<FetchedMessage>;
  /** Called whenever the open folder reports new messages (IMAP IDLE). */
  onNewMail(listener: () => void): void;
  onClose(listener: (error: Error | undefined) => void): void;
  close(): Promise<void>;
}

export type MailboxClientFactory = (config: MailConfig, secret: MailSecret) => MailboxClient;
