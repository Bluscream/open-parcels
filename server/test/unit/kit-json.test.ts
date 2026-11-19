import { describe, expect, it } from "vitest";
import {
  isOAuthRefusal,
  mayHaveMorePages,
  requiredList,
  UnexpectedResponseError,
} from "../../src/plugin/api.js";
import type { HttpResponse } from "../../src/plugin/http.js";

const response = (status: number, body: unknown): HttpResponse =>
  ({ status, body: JSON.stringify(body), headers: new Headers(), url: "" }) as HttpResponse;

describe("list envelopes", () => {
  it.each([
    [{ items: [], nextPage: "token" }, 0],
    [{ items: [], links: { next: "/page/2" } }, 0],
    [{ items: [1], hasMore: true }, 1],
    [{ items: [1], totalCount: 3 }, 1],
    [{ items: [1], pagination: { totalPages: 2 } }, 1],
  ])("reads %j as holding more", (envelope, listed) => {
    expect(mayHaveMorePages(envelope, listed)).toBe(true);
  });

  it.each([
    [{ items: [1], totalCount: 1 }, 1],
    [{ items: [], nextPage: null }, 0],
    [{ items: [], nextPage: { pagingState: null } }, 0],
    [[1, 2], 2],
  ])("reads %j as everything", (envelope, listed) => {
    expect(mayHaveMorePages(envelope, listed)).toBe(false);
  });

  it("requires a list to be there instead of reading a missing one as empty", () => {
    expect(requiredList({ items: [] }, "items", "Test")).toEqual([]);
    expect(() => requiredList({ error: "x" }, "items", "Test")).toThrow(UnexpectedResponseError);
  });
});

describe("OAuth refusals", () => {
  it("are 400s and 401s naming an OAuth error, nothing else", () => {
    expect(isOAuthRefusal(response(400, { error: "invalid_grant" }))).toBe(true);
    expect(isOAuthRefusal(response(401, { error: "invalid_client" }))).toBe(true);
    expect(isOAuthRefusal(response(400, { message: "bad request" }))).toBe(false);
    expect(isOAuthRefusal(response(403, { error: "invalid_grant" }))).toBe(false);
  });
});
