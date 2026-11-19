import type { Kysely } from "kysely";
import { simpleParser, type AddressObject } from "mailparser";
import type { Logger } from "pino";
import { isoNow, type Clock } from "../clock.js";
import type { SecretBox } from "../crypto/secrets.js";
import type { Database, SourceRow } from "../db/schema.js";
import type { Reconciler } from "../engine/reconciler.js";
import { secretAad, sessionAad, type SourceService } from "../engine/sources.js";
import type { ParcelSnapshot } from "../plugin/snapshot.js";
import {
  MAIL_PLUGIN,
  mailConfigSchema,
  mailProgressSchema,
  mailSecretSchema,
  type FetchedMessage,
  type MailboxClient,
  type MailboxClientFactory,
  type MailConfig,
  type MailInput,
  type MailInterpreter,
  type MailProgress,
  isGenericMailboxLabel,
  mailboxLabel,
} from "./types.js";

const DAY = 24 * 60 * 60 * 1000;
const RESYNC_MS = 15 * 60_000;
const RECONNECT_BASE_MS = 30_000;
const RECONNECT_MAX_MS = 15 * 60_000;

export interface MailWatcherDeps {
  readonly db: Kysely<Database>;
  readonly secrets: SecretBox;
  readonly sources: SourceService;
  readonly reconciler: Reconciler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly clientFactory: MailboxClientFactory;
  readonly interpret: MailInterpreter;
  /** Links parcels found in mail to their carrier's tracking source, so they get polled. */
  readonly followUp: (sourceId: string) => Promise<void>;
}

interface Connection {
  readonly client: MailboxClient;
  readonly config: MailConfig;
  progress: MailProgress;
  syncing: Promise<void>;
  resync: ReturnType<typeof setInterval> | undefined;
}

function isAuthFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "authenticationFailed" in error &&
    error.authenticationFailed === true
  );
}

function addressText(value: AddressObject | AddressObject[] | undefined): string {
  if (value === undefined) {
    return "";
  }
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) => entry.value.map((address) => address.address ?? "")).join(", ");
}

export async function toMailInput(source: Buffer): Promise<MailInput> {
  const parsed = await simpleParser(source, { skipImageLinks: true });
  return {
    messageId: parsed.messageId ?? null,
    from: addressText(parsed.from),
    subject: parsed.subject ?? "",
    text: parsed.text ?? null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    date: parsed.date ?? null,
  };
}

/** Watches every mailbox source over IMAP IDLE and feeds what it finds to the reconciler. */
export class MailWatcher {
  readonly #connections = new Map<string, Connection>();
  readonly #retries = new Map<string, number>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #stopped = true;

  constructor(private readonly deps: MailWatcherDeps) {}

  async start(): Promise<void> {
    this.#stopped = false;
    const rows = await this.deps.db
      .selectFrom("sources")
      .selectAll()
      .where("kind", "=", "mail")
      .where("state", "in", ["ok", "error"])
      .execute();
    await Promise.all(rows.map((row) => this.connect(row.id)));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers.values()) {
      clearTimeout(timer);
    }
    this.#timers.clear();
    await Promise.all([...this.#connections.keys()].map((id) => this.disconnect(id)));
  }

  /** (Re)connects one mailbox source; safe to call after its settings or sign-in changed. */
  async connect(sourceId: string): Promise<void> {
    await this.disconnect(sourceId);
    const row = await this.deps.db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirst();
    if (
      row?.kind !== "mail" ||
      row.plugin !== MAIL_PLUGIN ||
      row.secret_blob === null ||
      this.#stopped
    ) {
      return;
    }
    const config = mailConfigSchema.parse(JSON.parse(row.config));
    const secret = mailSecretSchema.parse(
      this.deps.secrets.decryptJson(row.secret_blob, secretAad(row.id)),
    );
    if (isGenericMailboxLabel(row.label, config.host)) {
      await this.deps.db
        .updateTable("sources")
        .set({ label: mailboxLabel(secret.username, config.host) })
        .where("id", "=", row.id)
        .execute();
    }
    const client = this.deps.clientFactory(config, secret);
    const connection: Connection = {
      client,
      config,
      progress: this.#progress(row),
      syncing: Promise.resolve(),
      resync: undefined,
    };
    try {
      await client.connect();
    } catch (error) {
      await this.#failed(sourceId, error);
      return;
    }
    this.#connections.set(sourceId, connection);
    this.#retries.delete(sourceId);
    client.onClose((error) => {
      if (this.#connections.get(sourceId) === connection) {
        this.#connections.delete(sourceId);
        this.#failed(sourceId, error ?? new Error("The mail server closed the connection.")).catch(
          (failure: unknown) => {
            this.deps.logger.error(
              { err: failure, source: sourceId },
              "Handling a closed mailbox failed.",
            );
          },
        );
      }
    });
    client.onNewMail(() => {
      this.#queueSync(sourceId, connection, [config.folders[0] ?? "INBOX"]);
    });
    connection.resync = setInterval(() => {
      this.#queueSync(sourceId, connection, config.folders);
    }, RESYNC_MS);
    connection.resync.unref();
    this.#queueSync(sourceId, connection, config.folders);
    await connection.syncing;
  }

  async disconnect(sourceId: string): Promise<void> {
    const connection = this.#connections.get(sourceId);
    this.#connections.delete(sourceId);
    if (connection === undefined) {
      return;
    }
    if (connection.resync !== undefined) {
      clearInterval(connection.resync);
    }
    // Let a sync that is already running finish; its own failures are handled inside the chain.
    await connection.syncing;
    await connection.client.close().catch((error: unknown) => {
      this.deps.logger.debug(
        { err: error, source: sourceId },
        "Closing the mail connection failed.",
      );
    });
  }

  #progress(row: SourceRow): MailProgress {
    if (row.session_blob === null) {
      return {};
    }
    const parsed = mailProgressSchema.safeParse(
      this.deps.secrets.decryptJson(row.session_blob, sessionAad(row.id)),
    );
    return parsed.success ? parsed.data : {};
  }

  #queueSync(sourceId: string, connection: Connection, folders: readonly string[]): void {
    connection.syncing = connection.syncing
      .then(() => this.#sync(sourceId, connection, folders))
      .catch((error: unknown) => this.#failed(sourceId, error));
  }

  async #sync(sourceId: string, connection: Connection, folders: readonly string[]): Promise<void> {
    const snapshots: ParcelSnapshot[] = [];
    // The first folder is opened last so it stays selected for IDLE.
    for (const folder of [...folders].reverse()) {
      const { uidValidity } = await connection.client.open(folder);
      const known = connection.progress[folder];
      let lastUid = known?.uidValidity === uidValidity ? known.lastUid : 0;
      const messages: AsyncIterable<FetchedMessage> =
        known?.uidValidity === uidValidity
          ? connection.client.fetchAfter(lastUid)
          : connection.client.fetchUids(
              await connection.client.searchSince(
                new Date(this.deps.clock.now().getTime() - connection.config.initialDays * DAY),
              ),
            );
      for await (const message of messages) {
        lastUid = Math.max(lastUid, message.uid);
        snapshots.push(...this.#interpret(sourceId, await toMailInput(message.source)));
      }
      connection.progress = { ...connection.progress, [folder]: { uidValidity, lastUid } };
    }
    if (snapshots.length > 0) {
      await this.deps.reconciler.ingest(sourceId, { snapshots, complete: false });
      await this.deps.followUp(sourceId);
    }
    await this.deps.db
      .updateTable("sources")
      .set({
        session_blob: this.deps.secrets.encryptJson(connection.progress, sessionAad(sourceId)),
        last_run_at: isoNow(this.deps.clock),
        last_ok_at: isoNow(this.deps.clock),
      })
      .where("id", "=", sourceId)
      .execute();
    await this.deps.sources.setState(sourceId, "ok", null);
  }

  #interpret(sourceId: string, mail: MailInput): readonly ParcelSnapshot[] {
    try {
      return this.deps.interpret(mail);
    } catch (error) {
      // One odd mail must not stop the mailbox; the content is never logged.
      this.deps.logger.warn(
        { source: sourceId, error: error instanceof Error ? error.name : "unknown" },
        "A mail could not be interpreted.",
      );
      return [];
    }
  }

  async #failed(sourceId: string, error: unknown): Promise<void> {
    if (this.#stopped) {
      // Shutting down: connections closing now is expected, and the database may be gone.
      return;
    }
    if (isAuthFailure(error)) {
      await this.deps.sources.setState(
        sourceId,
        "needs_sign_in",
        "The mail server rejected the sign-in. Enter the password again.",
      );
      return;
    }
    const attempt = (this.#retries.get(sourceId) ?? 0) + 1;
    this.#retries.set(sourceId, attempt);
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    this.deps.logger.warn(
      {
        source: sourceId,
        attempt,
        retryInMs: delay,
        error: error instanceof Error ? error.message : "unknown",
      },
      "Mailbox connection failed.",
    );
    await this.deps.sources.setState(
      sourceId,
      "error",
      "The mail server could not be reached; retrying.",
    );
    const timer = setTimeout(() => {
      this.#timers.delete(sourceId);
      if (this.#stopped) {
        return;
      }
      this.connect(sourceId).catch((failure: unknown) => {
        this.deps.logger.error(
          { err: failure, source: sourceId },
          "Reconnecting the mailbox failed.",
        );
      });
    }, delay);
    timer.unref();
    this.#timers.set(sourceId, timer);
  }
}
