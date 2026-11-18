import { ImapFlow } from "imapflow";
import type { FetchedMessage, MailboxClient, MailboxClientFactory } from "./types.js";

/** The real IMAP connection. Folders are opened read-only, so nothing is ever marked as read. */
export const imapClientFactory: MailboxClientFactory = (config, secret) => {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: secret.username, pass: secret.password },
    // imapflow's own logging would print server responses, which can contain personal data.
    logger: false,
  });
  async function* toMessages(range: string): AsyncIterable<FetchedMessage> {
    for await (const message of client.fetch(range, { uid: true, source: true }, { uid: true })) {
      if (message.source !== undefined) {
        yield { uid: message.uid, source: message.source };
      }
    }
  }
  const wrapper: MailboxClient = {
    connect: () => client.connect(),
    async open(folder) {
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      return { uidValidity: String(mailbox.uidValidity) };
    },
    async searchSince(since) {
      const result = await client.search({ since }, { uid: true });
      return Array.isArray(result) ? result : [];
    },
    fetchAfter: (afterUid) => toMessages(`${afterUid + 1}:*`),
    fetchUids: (uids) => toMessages(uids.join(",")),
    onNewMail(listener) {
      client.on("exists", listener);
    },
    onClose(listener) {
      client.on("close", () => {
        listener(undefined);
      });
      client.on("error", (error: unknown) => {
        listener(error instanceof Error ? error : new Error("IMAP connection failed."));
      });
    },
    close: async () => {
      await client.logout();
    },
  };
  return wrapper;
};
