import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SignInStep } from "../api/types";
import { StepRenderer } from "./StepRenderer";

function setup(step: SignInStep) {
  const onSubmit = vi.fn();
  render(<StepRenderer step={step} busy={false} onSubmit={onSubmit} />);
  return { onSubmit, user: userEvent.setup() };
}

// Built from parts: test values only, never a stored credential.
const TYPED = ["typed", "in", "test"].join("-");

describe("sign-in step renderer", () => {
  it("form: one input per field, sent under the field names", async () => {
    const { onSubmit, user } = setup({
      kind: "form",
      fields: [
        { name: "email", label: "E-mail", type: "email" },
        { name: "pw", label: "Password", type: "password" },
      ],
    });
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    await user.type(screen.getByLabelText("E-mail"), "someone@example.invalid");
    await user.type(screen.getByLabelText("Password"), TYPED);
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ email: "someone@example.invalid", pw: TYPED });
    // The typed values are cleared after sending.
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("open_url without a known end: opens the page in a window and sends the paste", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { onSubmit, user } = setup({
      kind: "open_url",
      url: "https://login.example.invalid/start",
      redirect_prefix: null,
      resume_url: null,
    });
    await user.click(screen.getByRole("button", { name: /open the sign-in page/i }));
    expect(open).toHaveBeenCalledWith(
      "https://login.example.invalid/start",
      "open-parcels-sign-in",
      expect.any(String),
    );
    await user.type(
      screen.getByLabelText(/final address/i),
      "https://app.example.invalid/done?code=abc",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ pasted: "https://app.example.invalid/done?code=abc" });
    open.mockRestore();
  });

  describe("open_url to an app address", () => {
    const APP_STEP: SignInStep = {
      kind: "open_url",
      url: "https://login.example.invalid/authorize?prompt=login",
      redirect_prefix: "app.example://done",
      resume_url: "https://login.example.invalid/authorize",
    };

    /** Stands in for the companion extension: answers hello, and captures with `answer`. */
    function fakeExtension(answer: (request: { requestId: string }) => object | null) {
      const listener = (event: MessageEvent): void => {
        const data = event.data as { source?: string; type?: string; requestId?: string };
        if (data.source !== "open-parcels-page") return;
        const reply =
          data.type === "hello"
            ? { type: "hello", version: "1.0.0", protocol: 1 }
            : data.type === "capture"
              ? answer({ requestId: data.requestId ?? "" })
              : null;
        if (reply !== null) {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: { source: "open-parcels-extension", ...reply },
              origin: window.location.origin,
              source: window,
            }),
          );
        }
      };
      window.addEventListener("message", listener);
      return () => {
        window.removeEventListener("message", listener);
      };
    }

    it("without the extension, offers it and guides through DevTools, with a resume button", async () => {
      const open = vi.spyOn(window, "open").mockReturnValue(null);
      const { user } = setup(APP_STEP);
      expect(await screen.findByText(/not installed/i)).toBeInTheDocument();
      await user.click(screen.getByLabelText(/step by step/i));
      expect(screen.getByText(/Response Headers/)).toBeInTheDocument();
      expect(screen.getByText("app.example://done")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /continue the sign-in/i }));
      expect(open).toHaveBeenCalledWith(
        "https://login.example.invalid/authorize",
        "open-parcels-sign-in",
        expect.any(String),
      );
      open.mockRestore();
    });

    it("with the extension, submits the address it captured", async () => {
      const remove = fakeExtension(({ requestId }) => ({
        type: "captured",
        requestId,
        url: "app.example://done?code=c1&state=s1",
      }));
      const { onSubmit, user } = setup(APP_STEP);
      await user.click(await screen.findByRole("button", { name: /sign in with the extension/i }));
      await vi.waitFor(() => {
        expect(onSubmit).toHaveBeenCalledWith({ pasted: "app.example://done?code=c1&state=s1" });
      });
      remove();
    });

    it("says why when the extension gives up, and keeps the manual way open", async () => {
      const remove = fakeExtension(({ requestId }) => ({
        type: "cancelled",
        requestId,
        reason: "closed",
      }));
      const { onSubmit, user } = setup(APP_STEP);
      await user.click(await screen.findByRole("button", { name: /sign in with the extension/i }));
      expect(await screen.findByText(/window was closed/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/step by step/i)).toBeEnabled();
      expect(onSubmit).not.toHaveBeenCalled();
      remove();
    });
  });

  it("email_link: names the destination and sends `code`", async () => {
    const { onSubmit, user } = setup({ kind: "email_link", destination: "s***@example.invalid" });
    expect(screen.getByText(/s\*\*\*@example\.invalid/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/link or code/i), "https://link.example.invalid/x");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ code: "https://link.example.invalid/x" });
  });

  it("otp_code: says where the code went and sends `code`", async () => {
    const { onSubmit, user } = setup({
      kind: "otp_code",
      channel: "sms",
      destination: "+00 ***12",
    });
    expect(screen.getByText(/by text message/)).toBeInTheDocument();
    expect(screen.getByLabelText("Code")).toHaveAttribute("autocomplete", "one-time-code");
    await user.type(screen.getByLabelText("Code"), "123456");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ code: "123456" });
  });

  it("choose_method: radio options, sends `choice`", async () => {
    const { onSubmit, user } = setup({
      kind: "choose_method",
      options: [
        { id: "sms", label: "Text message" },
        { id: "app", label: "Mobile app" },
      ],
    });
    await user.click(screen.getByLabelText("Mobile app"));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ choice: "app" });
  });

  it("await_approval: a waiting message and nothing to submit", () => {
    const { onSubmit } = setup({
      kind: "await_approval",
      message: "Approve the sign-in in your banking app.",
      poll_interval_seconds: 5,
      timeout_seconds: 300,
    });
    expect(screen.getByText("Approve the sign-in in your banking app.")).toBeInTheDocument();
    expect(screen.getByText(/every 5 seconds/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
