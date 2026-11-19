import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/client";
import type { Source } from "../api/types";
import { mockApi, type Recorded } from "../test/helpers";
import { SignInDialog } from "./SignInDialog";

/* Every value here is made up. */

const SOURCE = {
  id: "00000000-0000-4000-8000-0000000000s1",
  plugin: "fakeverify",
  kind: "account",
  label: "Test account",
} as unknown as Source;
const BASE = `/api/v1/sources/${SOURCE.id}/sign-in`;
const ATTEMPT = "attempt-1";
const step = (body: unknown) => ({
  body: { status: "step", attempt_id: ATTEMPT, expires_at: "2099-01-01T00:00:00.000Z", step: body },
});
const CODE_STEP = { kind: "otp_code", channel: "sms", destination: "+00 ** 01" };
const METHODS = (message: string) => ({
  kind: "choose_method",
  message,
  options: [
    { id: "sms", label: "Text message" },
    { id: "email", label: "Email" },
  ],
});

function routes(continues: ((request: Recorded) => ReturnType<typeof step> | object)[]) {
  return mockApi({
    [`GET ${BASE}/flows`]: () => ({
      body: [{ id: "verify", label: "Verify", type: "interactive", kinds: ["account"] }],
    }),
    [`POST ${BASE}/attempts`]: () => step(METHODS("First, choose")),
    [`POST ${BASE}/attempts/${ATTEMPT}/continue`]: (request) => continues.shift()?.(request),
    [`DELETE ${BASE}/attempts/${ATTEMPT}`]: () => ({ status: 204 }),
  });
}

function Harness(props: { readonly onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Opener
      </button>
      <SignInDialog
        source={open ? SOURCE : null}
        onClose={() => {
          props.onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

function renderDialog() {
  const onClose = vi.fn();
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Harness onClose={onClose} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  return {
    onClose,
    user,
    open: () => user.click(screen.getByRole("button", { name: "Opener" })),
  };
}

function renderStatic(flows: unknown[], carrierSecretSchema: unknown) {
  mockApi({
    [`GET ${BASE}/flows`]: () => ({ body: flows }),
    "GET /api/v1/carriers": () => ({
      body: [{ id: "fakeverify", secret_schema: carrierSecretSchema, sign_in_flows: [] }],
    }),
  });
  return renderDialog();
}

describe("static sign-in form", () => {
  const nullableCredentials = {
    anyOf: [
      {
        type: "object",
        properties: { username: { type: "string" }, password: { type: "string" } },
        required: ["username", "password"],
      },
      { type: "null" },
    ],
  };

  it("shows the fields of sign-in data that may be absent", async () => {
    const flow = { id: "credentials", label: "Credentials", type: "credentials", kinds: [] };
    const { open } = renderStatic([{ ...flow, secret_schema: null }], nullableCredentials);
    await open();
    expect(await screen.findByLabelText(/user ?name/iu)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/iu)).toBeInTheDocument();
  });

  it("shows only a flow's own fields, not the whole sign-in data", async () => {
    const flow = {
      id: "key",
      label: "API key",
      type: "api_key",
      kinds: [],
      secret_schema: { type: "object", properties: { apiKey: { type: "string" } } },
    };
    const { open } = renderStatic([flow], nullableCredentials);
    await open();
    expect(await screen.findByLabelText(/api ?key/iu)).toBeInTheDocument();
    expect(screen.queryByLabelText(/user ?name/iu)).not.toBeInTheDocument();
  });
});

describe("interactive sign-in dialog", () => {
  it("keeps the code step after a mistyped code instead of starting over", async () => {
    const calls = routes([
      () => step(CODE_STEP),
      // The server keeps the attempt after a failed try; only too many end it.
      () => ({ status: 400, body: { error: "sign_in_failed", message: "Wrong code." } }),
      () => ({ body: { status: "done" } }),
    ]);
    const { user, open } = renderDialog();
    await open();
    await user.click(await screen.findByRole("button", { name: /Start: Verify/u }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.type(await screen.findByRole("textbox"), "000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong code.");
    // Still on the code step: the next try answers it, with no new start.
    await user.type(screen.getByRole("textbox"), "123456");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Signed in/u)).toBeInTheDocument();
    expect(calls.filter((call) => call.path === `${BASE}/attempts`)).toHaveLength(1);
  });

  it("starts each step's form afresh, even when one method choice follows another", async () => {
    const calls = routes([() => step(METHODS("Then, choose again")), () => step(CODE_STEP)]);
    const { user, open } = renderDialog();
    await open();
    await user.click(await screen.findByRole("button", { name: /Start: Verify/u }));
    await user.click(await screen.findByLabelText("Email"));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("Then, choose again");
    // The second choice starts on its default, not on the first step's pick.
    expect(screen.getByLabelText("Text message")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const answers = calls.filter((call) => call.path.endsWith("/continue"));
    expect(answers.map((call) => call.body)).toEqual([
      { input: { choice: "email" } },
      { input: { choice: "sms" } },
    ]);
  });

  it("closes once on Escape, gives focus back and cancels the attempt on the server", async () => {
    const calls = routes([]);
    const { onClose, user, open } = renderDialog();
    await open();
    const opener = screen.getByRole("button", { name: "Opener" });
    await user.click(await screen.findByRole("button", { name: /Start: Verify/u }));
    await screen.findByText("First, choose");
    expect(document.activeElement).not.toBe(opener);
    const dialog = document.querySelector("dialog");
    dialog?.dispatchEvent(new Event("cancel", { cancelable: true }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    });
    expect(document.activeElement).toBe(opener);
  });
});
