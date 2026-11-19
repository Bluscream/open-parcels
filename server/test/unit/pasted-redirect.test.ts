import { describe, expect, it } from "vitest";
import { extractAddress, pastedRedirect, type SignInContext } from "../../src/plugin/sign-in.js";

/* Every address here is made up. */
const FINAL = "app.example://sign-in/done?code=c1&state=s1";

describe("extractAddress", () => {
  it.each([
    ["the address alone", FINAL],
    ["surrounding whitespace", `  ${FINAL}\n`],
    ["a DevTools header line", `Location: ${FINAL}`],
    ["a quoted value", `"${FINAL}"`],
    ["a copied header list", `content-type: text/html\nlocation\n${FINAL}\nvary: Cookie`],
    [
      "a page address before the redirect",
      `https://login.example.invalid/token-url?x=1 then ${FINAL}`,
    ],
  ])("finds the redirect in %s", (_label, pasted) => {
    expect(extractAddress(pasted)).toBe(FINAL);
  });

  it("leaves text without an address for the carrier to refuse", () => {
    expect(extractAddress("  not an address ")).toBe("not an address");
  });
});

describe("pastedRedirect", () => {
  const flow = pastedRedirect<unknown, string>({
    start: () =>
      Promise.resolve({
        url: "https://login.example.invalid/authorize?redirect_uri=app.example%3A%2F%2Fsign-in%2Fdone&prompt=login&state=s1",
        state: "s1",
      }),
    finish: (_context, state, pasted) => Promise.resolve(`${String(state)}:${pasted}`),
  });
  const context = { config: {}, kind: "account", clock: {} } as unknown as SignInContext<unknown>;

  it("tells the UI where the sign-in ends and how to resume it without a new password", async () => {
    const turn = await flow.start(context);
    expect("step" in turn && turn.step).toMatchObject({
      kind: "open_url",
      redirectPrefix: "app.example://sign-in/done",
      resumeUrl:
        "https://login.example.invalid/authorize?redirect_uri=app.example%3A%2F%2Fsign-in%2Fdone&state=s1",
    });
  });

  it("hands the carrier only the address out of a messy paste", async () => {
    const turn = await flow.continue(context, "s1", { pasted: `Location: ${FINAL}` });
    expect(turn).toEqual({ secret: `s1:${FINAL}` });
  });
});
