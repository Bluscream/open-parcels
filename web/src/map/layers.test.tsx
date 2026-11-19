import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "../test/helpers";
import { LayerControl } from "./LayerControl";
import { tileUrl, useMapStyle, type MapLayer } from "./layers";

function layer(id: string, label: string, kind: MapLayer["kind"] = "base"): MapLayer {
  return {
    id,
    label,
    kind,
    max_zoom: 18,
    attribution: label,
    satellite: id === "satellite",
    dark: false,
  };
}

const LAYERS = [
  layer("osm", "Map"),
  layer("satellite", "Satellite"),
  layer("borders", "Borders only"),
  layer("labels", "Borders & labels", "overlay"),
];

/** The control as SharedMap uses it, with the active style printed for the assertions. */
function Harness(): ReactNode {
  const style = useMapStyle();
  return (
    <>
      <LayerControl
        layers={style.layers}
        base={style.base}
        overlay={style.overlay}
        onChoose={style.choose}
      />
      <output aria-label="active">{`${style.base.id}+${style.overlay?.id ?? "none"}`}</output>
    </>
  );
}

function renderHarness(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mockApi({
    "GET /api/v1/map/layers": () => ({
      body: { layers: LAYERS, default_base: "borders", default_overlay: null },
    }),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("map layers", () => {
  it("starts on the server's default and remembers the user's pick", async () => {
    renderHarness();
    expect(await screen.findByText("borders+none")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Map style" }));
    await userEvent.click(screen.getByRole("radio", { name: "Satellite" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Borders & labels" }));
    expect(screen.getByText("satellite+labels")).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem("open-parcels.map-style") ?? "{}")).toEqual({
      base: "satellite",
      overlay: "labels",
    });
  });

  it("restores a remembered choice and ignores one the server no longer offers", async () => {
    window.localStorage.setItem(
      "open-parcels.map-style",
      JSON.stringify({ base: "custom", overlay: "labels" }),
    );
    renderHarness();
    expect(await screen.findByText("borders+labels")).toBeTruthy();
  });

  it("closes the menu with Escape", async () => {
    renderHarness();
    await screen.findByText("borders+none");
    await userEvent.click(screen.getByRole("button", { name: "Map style" }));
    expect(screen.getByRole("group", { name: "Map style" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Map style" })).toBeNull();
  });

  it("builds tile URLs against the base URI, as under HA ingress", () => {
    expect(tileUrl("satellite")).toBe(
      `${new URL("tiles/satellite/", document.baseURI).toString()}{z}/{x}/{y}`,
    );
  });
});
