import { describe, expect, it } from "vitest";
import { icsCourier } from "../../src/carriers/ics_courier/index.js";
import { register } from "../../src/engine/registry.js";
import { TransientError, UnexpectedResponseError } from "../../src/plugin/errors.js";
import { fakeContext, fakeNetwork, inOrder, raw, type Answer } from "./harness.js";

const JSON_TYPE = { "content-type": "application/json" };
/** Replies in order; once they run out, 404 with an empty body. */
const scripted = (replies: Answer[]) =>
  fakeNetwork([inOrder(...replies)], () => raw("", 404, JSON_TYPE));

// Made-up codes and values only.
const CODE = "ICS000000001";
const plugin = register(icsCourier);

function record(sequence: number, code: string, status: string, date: string): string {
  return (
    "<TrackingInfoWithSeq>" +
    `<Sequence>${sequence}</Sequence><Code>${code}</Code>` +
    `<Status>${status}</Status><StatusDate>${date}</StatusDate>` +
    "</TrackingInfoWithSeq>"
  );
}

function soap(...records: string[]): Answer {
  return raw(
    '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
      "<soap:Body><TracePackgeWithSequenceResponse><TracePackgeWithSequenceResult>" +
      `<TrackingInfoWithSeq>${records.join("")}</TrackingInfoWithSeq>` +
      "</TracePackgeWithSequenceResult></TracePackgeWithSequenceResponse></soap:Body></soap:Envelope>",
    200,
    { "content-type": "text/xml" },
  );
}

async function run(replies: Answer[]) {
  const { fetchImpl, calls } = scripted(replies);
  const { base, unknown } = fakeContext(icsCourier.http, fetchImpl);
  const result = await plugin.track(base, {}, null, [CODE]);
  return { result, calls, unknown };
}

describe("ics_courier tracking", () => {
  it("reads a delivered parcel with history, keeping names out of the status", async () => {
    const { result, calls, unknown } = await run([
      soap(
        record(
          2,
          "DELIV",
          "Delivered at: Test Person &amp; Co 1 Example St",
          "2026-11-18T14:05:00",
        ),
        record(1, "PUP", "Picked up", "2026-11-17T09:00:00"),
      ),
    ]);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toContain(`<string>${CODE}</string>`);
    expect(calls[0]?.headers.get("soapaction")).toContain("TracePackgeWithSequence");
    const parcel = result.snapshots[0];
    expect(parcel?.status).toBe("delivered");
    expect(parcel?.rawStatus).toBe("Delivered");
    // Toronto is UTC-5 in November.
    expect(parcel?.deliveredAt).toBe("2026-11-18T19:05:00.000Z");
    expect(parcel?.plannedFrom).toBeNull();
    expect(parcel?.history.map((event) => [event.at, event.status, event.rawStatus])).toEqual([
      ["2026-11-18T19:05:00.000Z", "delivered", "Delivered"],
      ["2026-11-17T14:00:00.000Z", null, "PUP"],
    ]);
    expect(unknown).toEqual(["status_code:PUP"]);
  });

  it("treats the not-found record as not found", async () => {
    const { result } = await run([soap(record(0, "", "Not Found", ""))]);
    expect(result.snapshots).toEqual([]);
  });

  it("reports an unknown latest code", async () => {
    const { result, unknown } = await run([
      soap(record(1, "NEWCODE", "Something", "2026-11-18T10:00:00")),
    ]);
    expect(result.snapshots[0]?.status).toBeNull();
    expect(unknown).toEqual(["status_code:NEWCODE"]);
  });

  it("stops on faults, odd bodies and network errors", async () => {
    const fault: Answer = raw(
      '<soap:Envelope xmlns:soap="x"><soap:Body><soap:Fault><faultstring>no</faultstring></soap:Fault></soap:Body></soap:Envelope>',
      200,
      JSON_TYPE,
    );
    await expect(run([fault])).rejects.toThrow(UnexpectedResponseError);
    await expect(run([raw("<html>blocked</html>", 200, JSON_TYPE)])).rejects.toThrow(
      UnexpectedResponseError,
    );
    await expect(run([soap()])).rejects.toThrow(UnexpectedResponseError);
    await expect(run([raw("", 500, JSON_TYPE)])).rejects.toThrow(TransientError);
    await expect(run([new Error("offline")])).rejects.toThrow(TransientError);
  });
});
