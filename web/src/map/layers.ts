import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { getApiV1MapLayers, type GetApiV1MapLayers200LayersItem } from "../api/generated";

export type MapLayer = GetApiV1MapLayers200LayersItem;

export const mapLayersKey = ["map", "layers"] as const;
const STORAGE_KEY = "open-parcels.map-style";

/** Used while the list loads or when it cannot be read: plain OpenStreetMap, as before. */
export const FALLBACK_LAYER: MapLayer = {
  id: "osm",
  label: "Map",
  kind: "base",
  max_zoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  satellite: false,
};

/**
 * Tiles of one layer through this server's own proxy, resolved against the base URI so it also
 * works under the Home Assistant ingress prefix.
 */
export function tileUrl(layerId: string): string {
  return `${new URL(`tiles/${encodeURIComponent(layerId)}/`, document.baseURI).toString()}{z}/{x}/{y}`;
}

export interface MapStyle {
  readonly base: string;
  readonly overlay: string | null;
}

function readStored(): Partial<MapStyle> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const { base, overlay } = parsed as Record<string, unknown>;
    return {
      ...(typeof base === "string" ? { base } : {}),
      ...(typeof overlay === "string" || overlay === null ? { overlay } : {}),
    };
  } catch {
    return {};
  }
}

export function useMapLayers() {
  return useQuery({
    queryKey: mapLayersKey,
    queryFn: ({ signal }) => getApiV1MapLayers({ signal }),
    staleTime: 5 * 60_000,
  });
}

export interface ActiveStyle {
  readonly layers: readonly MapLayer[];
  readonly base: MapLayer;
  readonly overlay: MapLayer | null;
  readonly choose: (change: Partial<MapStyle>) => void;
}

/**
 * The style this browser shows: the user's last pick (kept in localStorage), else the server's
 * default. A remembered layer the server no longer offers falls back to the default.
 */
export function useMapStyle(): ActiveStyle {
  const query = useMapLayers();
  const [stored, setStored] = useState<Partial<MapStyle>>(readStored);
  const layers = query.data?.layers ?? [FALLBACK_LAYER];
  const find = (id: string | null | undefined, kind: MapLayer["kind"]): MapLayer | undefined =>
    layers.find((layer) => layer.id === id && layer.kind === kind);
  const base =
    find(stored.base, "base") ?? find(query.data?.default_base, "base") ?? FALLBACK_LAYER;
  const overlay =
    stored.overlay === undefined
      ? (find(query.data?.default_overlay, "overlay") ?? null)
      : (find(stored.overlay, "overlay") ?? null);
  const choose = useCallback((change: Partial<MapStyle>) => {
    setStored((previous) => {
      const next = { ...previous, ...change };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode without storage: the choice lasts for this page only.
      }
      return next;
    });
  }, []);
  return { layers, base, overlay, choose };
}
