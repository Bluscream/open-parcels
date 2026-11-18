import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { App } from "../../src/api/app.js";
import { createTestContext, signIn, type TestContext } from "../helpers.js";

let context: TestContext;
let app: App;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  context = await createTestContext();
  app = await context.app();
  await app.listen({ host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const session = await signIn(context, app);
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tokens",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    payload: { name: "sse", scopes: ["read", "write"] },
  });
  token = created.json<{ token: string }>().token;
});
afterEach(async () => {
  await context.close();
});

interface SseMessage {
  id: string;
  event: string;
  data: unknown;
}

/** Reads SSE messages from a live stream until `count` arrived. */
async function readMessages(response: Response, count: number): Promise<SseMessage[]> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error("The response has no body.");
  }
  const decoder = new TextDecoder();
  const messages: SseMessage[] = [];
  let buffer = "";
  while (messages.length < count) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    const chunk: unknown = result.value;
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("The stream delivered something other than bytes.");
    }
    buffer += decoder.decode(chunk, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const fields = Object.fromEntries(
        block
          .split("\n")
          .filter((line) => !line.startsWith(":") && line.includes(": "))
          .map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)]),
      ) as Record<string, string>;
      if (fields["event"] !== undefined && fields["id"] !== undefined) {
        messages.push({
          id: fields["id"],
          event: fields["event"],
          data: JSON.parse(fields["data"] ?? "null"),
        });
      }
      end = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return messages;
}

async function track(barcode: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/v1/parcels`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ carrier: "dhl", barcode }),
  });
  expect(response.status).toBe(201);
}

describe("SSE event stream", () => {
  it("requires authentication", async () => {
    const response = await fetch(`${baseUrl}/api/v1/events`);
    expect(response.status).toBe(401);
  });

  it("pushes new events live", async () => {
    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const pending = readMessages(stream, 1);
    await track("00340434000000000001");
    const [message] = await pending;
    controller.abort();
    expect(message?.event).toBe("parcel.registered");
    expect(message?.data).toMatchObject({
      parcel: { barcode: "00340434000000000001", status: "registered" },
    });
  });

  it("replays missed events after Last-Event-ID, in order and without duplicates", async () => {
    await track("00340434000000000001");
    await track("00340434000000000002");
    await track("00340434000000000003");
    const firstSeq = (
      await context.services.db
        .selectFrom("outbox")
        .select("seq")
        .orderBy("seq")
        .executeTakeFirstOrThrow()
    ).seq;

    const controller = new AbortController();
    const stream = await fetch(`${baseUrl}/api/v1/events`, {
      headers: { authorization: `Bearer ${token}`, "last-event-id": String(firstSeq) },
      signal: controller.signal,
    });
    const pending = readMessages(stream, 3);
    await track("00340434000000000004");
    const messages = await pending;
    controller.abort();
    const barcodes = messages.map(
      (message) => (message.data as { parcel: { barcode: string } }).parcel.barcode,
    );
    expect(barcodes).toEqual([
      "00340434000000000002",
      "00340434000000000003",
      "00340434000000000004",
    ]);
  });
});
