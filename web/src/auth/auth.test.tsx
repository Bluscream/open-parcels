import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, renderApp, SIGNED_IN } from "../test/helpers";

// Made up for the test, built from parts so it never looks like a stored credential.
const OWNER_PASSWORD = ["correct", "horse", "battery"].join("-");

describe("first start and sign-in", () => {
  it("sets the owner password with the setup code, then opens the app", async () => {
    let done = false;
    const calls = mockApi({
      "GET /api/v1/session": () => ({
        body: done
          ? SIGNED_IN
          : {
              authenticated: false,
              method: null,
              scopes: [],
              csrf_token: null,
              setup_required: true,
            },
      }),
      "POST /api/v1/setup": () => {
        done = true;
        return { body: { csrf_token: "csrf-test-value" } };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText("Setup code"), "ABCD-EFGH");
    await user.type(screen.getByLabelText("Owner password"), OWNER_PASSWORD);
    await user.type(screen.getByLabelText("Repeat the password"), OWNER_PASSWORD);
    await user.click(screen.getByRole("button", { name: /set password/i }));

    expect(await screen.findByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    const setup = calls.find((call) => call.path === "/api/v1/setup");
    expect(setup?.body).toEqual({ setup_code: "ABCD-EFGH", password: OWNER_PASSWORD });
  });

  it("refuses mismatched passwords before calling the server", async () => {
    const calls = mockApi({
      "GET /api/v1/session": () => ({
        body: {
          authenticated: false,
          method: null,
          scopes: [],
          csrf_token: null,
          setup_required: true,
        },
      }),
    });
    const user = userEvent.setup();
    renderApp();
    await user.type(await screen.findByLabelText("Setup code"), "ABCD");
    await user.type(screen.getByLabelText("Owner password"), OWNER_PASSWORD);
    await user.type(screen.getByLabelText("Repeat the password"), `${OWNER_PASSWORD}x`);
    await user.click(screen.getByRole("button", { name: /set password/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not match");
    expect(calls.some((call) => call.path === "/api/v1/setup")).toBe(false);
  });

  it("shows the server's message for a wrong password and signs in on the next try", async () => {
    let signedIn = false;
    mockApi({
      "GET /api/v1/session": () => ({
        body: signedIn
          ? SIGNED_IN
          : {
              authenticated: false,
              method: null,
              scopes: [],
              csrf_token: null,
              setup_required: false,
            },
      }),
      "POST /api/v1/session": (request) => {
        const body = request.body as { password: string };
        if (body.password !== OWNER_PASSWORD) {
          return {
            status: 401,
            body: { error: "wrong_password", message: "That password is not correct." },
          };
        }
        signedIn = true;
        return { body: { csrf_token: "csrf-test-value" } };
      },
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    const user = userEvent.setup();
    renderApp();

    await user.type(await screen.findByLabelText("Owner password"), "wrong-one");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("not correct");

    await user.type(screen.getByLabelText("Owner password"), OWNER_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    });
  });

  it("needs no sign-in under Home Assistant ingress", async () => {
    mockApi({
      "GET /api/v1/session": () => ({
        body: { ...SIGNED_IN, method: "ingress", csrf_token: null, setup_required: true },
      }),
      "GET /api/v1/parcels": () => ({ body: [] }),
    });
    renderApp();
    expect(await screen.findByRole("heading", { name: "Parcels" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });
});
