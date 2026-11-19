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

  it("open_url: a link to open, and the pasted address sent as `pasted`", async () => {
    const { onSubmit, user } = setup({
      kind: "open_url",
      url: "https://login.example.invalid/start",
    });
    expect(screen.getByRole("link", { name: /open the sign-in page/i })).toHaveAttribute(
      "href",
      "https://login.example.invalid/start",
    );
    await user.type(
      screen.getByLabelText(/address the browser ended on/i),
      "https://app.example.invalid/done?code=abc",
    );
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith({ pasted: "https://app.example.invalid/done?code=abc" });
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
