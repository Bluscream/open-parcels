import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import type { FetchedMessage, MailboxClient, MailInput } from "../../src/mail/types.js";
import { snapshot } from "../../src/plugin/api.js";
import { FakeWorld, fakePost } from "../fakes/carriers.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

interface FakeMessage {
  readonly uid: number;
  readonly date: Date;
  readonly source: Buffer;
}

/** An in-memory mailbox that behaves like the IMAP wrapper. */
class FakeMailbox implements MailboxClient {
  folders = new Map<string, { uidValidity: string; messages: FakeMessage[] }>([
    ["INBOX", { uidValidity: "1", messages: [] }],
  ]);
  current = "INBOX";
  connectError: Error | undefined;
  newMail: (() => void) | undefined;
  closed: ((error: Error | undefined) => void) | undefined;
  fetched: number[] = [];

  connect(): Promise<void> {
    return this.connectError === undefined ? Promise.resolve() : Promise.reject(this.connectError);
  }
  open(folder: string): Promise<{ uidValidity: string }> {
    this.current = folder;
    return Promise.resolve({ uidValidity: this.#folder().uidValidity });
  }
  searchSince(since: Date): Promise<number[]> {
    return Promise.resolve(
      this.#folder()
        .messages.filter((message) => message.date >= since)
        .map((message) => message.uid),
    );
  }
  async *fetchAfter(afterUid: number): AsyncIterable<FetchedMessage> {
    for (const message of this.#folder().messages.filter((entry) => entry.uid > afterUid)) {
      this.fetched.push(message.uid);
      yield await Promise.resolve(message);
    }
  }
  async *fetchUids(uids: readonly number[]): AsyncIterable<FetchedMessage> {
    for (const message of this.#folder().messages.filter((entry) => uids.includes(entry.uid))) {
      this.fetched.push(message.uid);
      yield await Promise.resolve(message);
    }
  }
  onNewMail(listener: () => void): void {
    this.newMail = listener;
  }
  onClose(listener: (error: Error | undefined) => void): void {
    this.closed = listener;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  #folder() {
    const folder = this.folders.get(this.current);
    if (folder === undefined) {
      throw new Error(`No folder ${this.current}.`);
    }
    return folder;
  }
  add(uid: number, date: string, subject: string): void {
    const raw = [
      `From: Shop <noreply@shop.example.invalid>`,
      `To: someone@example.invalid`,
      `Subject: ${subject}`,
      `Date: ${new Date(date).toUTCString()}`,
      `Message-ID: <${uid}@example.invalid>`,
      "",
      `Your parcel ${subject} is on its way.`,
    ].join("\r\n");
    this.#folder().messages.push({ uid, date: new Date(date), source: Buffer.from(raw) });
  }
}

let context: TestContext;
let mailbox: FakeMailbox;
let seen: MailInput[];
let app: App;
let headers: Record<string, string>;

/** Interprets a subject "FP<digits>" as a fakepost parcel, "BROKEN" as a mail that throws. */
function interpret(mail: MailInput) {
  seen.push(mail);
  if (mail.subject === "BROKEN") {
    throw new Error("parser bug");
  }
  const match = /FP\d+/.exec(mail.subject);
  return match === null
    ? []
    : [
        snapshot({
          carrier: "fakepost",
          barcode: match[0],
          status: "registered",
          rawStatus: "Shipping notice",
        }),
      ];
}

beforeEach(async () => {
  mailbox = new FakeMailbox();
  seen = [];
  context = await createTestContextWithMail();
  await context.services.mail.start();
  app = await context.app();
  const session = await signIn(context, app);
  headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
});
afterEach(async () => {
  await context.services.mail.stop();
  await context.close();
});

async function createTestContextWithMail(): Promise<TestContext> {
  return createTestContext({
    plugins: [fakePost(new FakeWorld())],
    mailClientFactory: () => mailbox,
    mailInterpreter: interpret,
  });
}

const mailSecret = { username: "someone@example.invalid", password: ["made", "up"].join("-") };

async function addMailbox(): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/sources",
    headers,
    payload: {
      plugin: "imap",
      kind: "mail",
      label: "Inbox",
      config: { host: "imap.example.invalid" },
      secret: mailSecret,
    },
  });
  expect(response.statusCode).toBe(201);
  expect(response.body).not.toContain("made-up");
  return response.json<{ id: string }>().id;
}

describe("mail watcher", () => {
  it("imports the last 30 days on first sync and follows found parcels with their carrier", async () => {
    mailbox.add(1, "2026-09-01T10:00:00Z", "Old FP0001");
    mailbox.add(2, "2026-11-10T10:00:00Z", "Recent FP0002");
    mailbox.add(3, "2026-11-17T10:00:00Z", "Newsletter");
    const id = await addMailbox();

    expect(seen.map((mail) => mail.subject)).toEqual(["Recent FP0002", "Newsletter"]);
    const parcels = await context.services.parcels.repository.list({}, false);
    expect(parcels.map((parcel) => parcel.barcode)).toEqual(["FP0002"]);
    expect(parcels[0]?.sources.map((source) => source.role).sort()).toEqual(["mail", "primary"]);
    const source = await context.services.sources.get(id);
    expect(source).toMatchObject({ state: "ok" });
    const row = await context.services.db
      .selectFrom("sources")
      .select("session_blob")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(row.session_blob?.toString("utf8") ?? "").not.toContain("lastUid");
  });

  it("fetches only new messages when the server announces them", async () => {
    mailbox.add(1, "2026-11-17T10:00:00Z", "First FP0001");
    await addMailbox();
    mailbox.fetched = [];
    mailbox.add(2, "2026-11-18T10:00:00Z", "Second FP0002");
    mailbox.newMail?.();
    await context.services.mail.stop();
    expect(mailbox.fetched).toEqual([2]);
    expect(
      (await context.services.parcels.repository.list({}, false))
        .map((parcel) => parcel.barcode)
        .sort(),
    ).toEqual(["FP0001", "FP0002"]);
  });

  it("starts over when the folder's UIDVALIDITY changes", async () => {
    mailbox.add(5, "2026-11-17T10:00:00Z", "First FP0001");
    const id = await addMailbox();
    mailbox.folders.set("INBOX", { uidValidity: "2", messages: [] });
    mailbox.add(1, "2026-11-18T09:00:00Z", "Rebuilt FP0003");
    mailbox.fetched = [];
    await context.services.mail.connect(id);
    expect(mailbox.fetched).toEqual([1]);
  });

  it("keeps going when one mail cannot be interpreted", async () => {
    mailbox.add(1, "2026-11-17T10:00:00Z", "BROKEN");
    mailbox.add(2, "2026-11-17T11:00:00Z", "Fine FP0009");
    await addMailbox();
    expect(
      (await context.services.parcels.repository.list({}, false)).map((parcel) => parcel.barcode),
    ).toEqual(["FP0009"]);
  });

  it("asks for a new password when the server rejects the sign-in, and retries on network errors", async () => {
    mailbox.connectError = Object.assign(new Error("auth"), { authenticationFailed: true });
    const id = await addMailbox();
    expect((await context.services.sources.get(id))?.state).toBe("needs_sign_in");

    mailbox.connectError = undefined;
    await context.services.mail.connect(id);
    mailbox.closed?.(new Error("connection reset"));
    await new Promise((resolve) => setImmediate(resolve));
    expect((await context.services.sources.get(id))?.state).toBe("error");
  });

  it("rejects mailboxes without a host or sign-in", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers,
      payload: { plugin: "imap", kind: "mail", label: "x", config: {} },
    });
    expect(response.statusCode).toBe(400);
  });
});
