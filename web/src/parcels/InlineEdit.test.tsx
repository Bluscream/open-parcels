import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mockApi, parcel, renderApp, SIGNED_IN } from "../test/helpers";

/* Every value is made up. */
const ID = "00000000-0000-4000-8000-0000000000e1";
const BASE = { ...parcel({ id: ID, label: "Desk lamp", status: "in_transit" }), sources: [] };

/** A fake server that keeps what a successful PATCH answered. */
function routes(patch: (body: unknown) => { status?: number; body: unknown }) {
  let current: unknown = BASE;
  return mockApi({
    "GET /api/v1/session": () => ({ body: SIGNED_IN }),
    [`GET /api/v1/parcels/${ID}`]: () => ({ body: current }),
    [`PATCH /api/v1/parcels/${ID}`]: (request) => {
      const answer = patch(request.body);
      if (answer.status === undefined) current = answer.body;
      return answer;
    },
    "GET /api/v1/parcels": () => ({ body: [] }),
    "GET /api/v1/carriers": () => ({ body: [] }),
    "GET /api/v1/settings": () => ({ body: { home: null } }),
  });
}

describe("editing a parcel in place", () => {
  it("renames with the pencil and Enter, and Escape leaves it as it was", async () => {
    const calls = routes((body) => ({ body: { ...BASE, ...(body as object) } }));
    const user = userEvent.setup();
    renderApp(`/parcels/${ID}`);
    await user.click(await screen.findByRole("button", { name: "Rename" }));
    // The field opens focused with the current label; select it and type over it.
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveFocus();
    await user.keyboard("{Control>}a{/Control}Floor lamp{Enter}");
    expect(await screen.findByRole("heading", { name: "Floor lamp" })).toBeInTheDocument();
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ label: "Floor lamp" });

    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.keyboard(" changed{Escape}");
    expect(screen.getByRole("heading", { name: "Floor lamp" })).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("saves a picked status at once and puts it back when the server refuses", async () => {
    let refuse = false;
    const calls = routes((body) =>
      refuse
        ? { status: 500, body: { error: "internal", message: "Try again." } }
        : { body: { ...BASE, ...(body as object), status: "at_pickup_point" } },
    );
    const user = userEvent.setup();
    renderApp(`/parcels/${ID}`);
    await user.click(await screen.findByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "at_pickup_point");
    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        manual_status: "at_pickup_point",
      });
    });

    refuse = true;
    await user.click(screen.getByRole("button", { name: "Change status" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "delivered");
    expect(await screen.findByText("Try again.")).toBeInTheDocument();
    expect(screen.queryByText("Delivered", { selector: ".badge, .status-badge" })).toBeNull();
  });
});
