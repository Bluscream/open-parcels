import { createHash } from "node:crypto";

/**
 * The map styles the server proxies. Only providers whose terms allow keyless use by a personal,
 * self-hosted server that caches tiles are built in; anything else (CARTO, Esri, MapTiler, Stadia,
 * Thunderforest, Mapbox) is reached through the custom provider with the owner's own key.
 * Upstream URLs and keys never leave the server: the web only sees ids, labels and attribution.
 */
export type LayerKind = "base" | "overlay";
export type TileFormat = "png" | "jpg";

export interface TileLayerDef {
  readonly id: string;
  readonly label: string;
  readonly kind: LayerKind;
  /** `{s}` subdomain, `{z}/{x}/{y}`, `{r}` retina suffix (always empty) and `{key}`. */
  readonly url: string;
  readonly subdomains?: readonly string[];
  readonly format: TileFormat;
  /** The deepest zoom the provider serves; the map scales its tiles up beyond it. */
  readonly maxZoom: number;
  /** HTML, shown in the map's attribution control. */
  readonly attribution: string;
  /** Photographic imagery: the dark-mode filter is not applied. */
  readonly satellite: boolean;
  /** Folder under the tile cache; changes when the upstream does. */
  readonly cacheKey: string;
  /** Filled into `{key}`; never sent to the browser. */
  readonly apiKey?: string;
}

const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const EOX =
  '<a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2025)';
const EOX_OVERLAY = `${OSM}, rendering &copy; <a href="https://eox.at">EOX</a>`;
const EOX_WMTS = "https://tiles.maps.eox.at/wmts/1.0.0";

export const BUILTIN_LAYERS: readonly TileLayerDef[] = [
  {
    id: "osm",
    label: "Map",
    kind: "base",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    format: "png",
    maxZoom: 19,
    attribution: OSM,
    satellite: false,
    cacheKey: "osm",
  },
  {
    id: "topo",
    label: "Topographic",
    kind: "base",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c"],
    format: "png",
    maxZoom: 17,
    attribution: `Map data: ${OSM}, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)`,
    satellite: false,
    cacheKey: "topo",
  },
  {
    id: "satellite",
    label: "Satellite",
    kind: "base",
    // WMTS REST order: TileMatrix/TileRow/TileCol, i.e. z/y/x.
    url: `${EOX_WMTS}/s2cloudless-2025_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg`,
    format: "jpg",
    // Sentinel-2 is 10 m imagery: deeper tiles are only upscaled copies.
    maxZoom: 15,
    attribution: EOX,
    satellite: true,
    cacheKey: "s2cloudless-2025",
  },
  {
    id: "borders",
    label: "Borders only",
    kind: "base",
    url: `${EOX_WMTS}/overlay_bright_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.png`,
    format: "png",
    maxZoom: 18,
    attribution: EOX_OVERLAY,
    satellite: false,
    cacheKey: "eox-overlay-bright",
  },
  {
    id: "labels",
    label: "Borders & labels",
    kind: "overlay",
    url: `${EOX_WMTS}/overlay_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.png`,
    format: "png",
    maxZoom: 18,
    attribution: EOX_OVERLAY,
    satellite: false,
    cacheKey: "eox-overlay",
  },
];

export const BASE_LAYER_CHOICES = [
  ...BUILTIN_LAYERS.filter((layer) => layer.kind === "base").map((layer) => layer.id),
  "custom",
] as const;
export const OVERLAY_CHOICES = [
  "none",
  ...BUILTIN_LAYERS.filter((layer) => layer.kind === "overlay").map((layer) => layer.id),
] as const;

const PLACEHOLDER = /\{([^}]*)\}/g;
const KNOWN = new Set(["s", "z", "x", "y", "r", "key"]);

/** Why a custom URL template is unusable, or null when it is fine. */
export function templateProblem(template: string): string | null {
  const names = [...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? "");
  const unknown = names.find((name) => !KNOWN.has(name));
  if (unknown !== undefined) {
    return `Unknown placeholder {${unknown}}; use {s}, {z}, {x}, {y}, {r} and {key}.`;
  }
  if (!["z", "x", "y"].every((name) => names.includes(name))) {
    return "The template must contain {z}, {x} and {y}.";
  }
  let url: URL;
  try {
    url = new URL(template.replace(PLACEHOLDER, "a"));
  } catch {
    return "Not a URL.";
  }
  if (url.protocol !== "https:") return "Tile servers must be reached over https.";
  if (url.username !== "" || url.password !== "") return "Put credentials into {key}, not the URL.";
  return null;
}

export interface CustomProvider {
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly attribution: string | undefined;
  readonly maxZoom: number;
}

/** The custom provider as a layer; null when its template needs a key that is not set. */
export function customLayer(custom: CustomProvider): TileLayerDef | null {
  if (custom.url.includes("{key}") && custom.apiKey === undefined) return null;
  const hash = createHash("sha256").update(custom.url).digest("hex").slice(0, 12);
  const format: TileFormat = /\.jpe?g(\?|$)/i.test(custom.url) ? "jpg" : "png";
  return {
    id: "custom",
    label: "Custom",
    kind: "base",
    url: custom.url,
    subdomains: ["a", "b", "c"],
    format,
    maxZoom: custom.maxZoom,
    attribution: escapeHtml(custom.attribution ?? "Custom tile provider"),
    satellite: false,
    cacheKey: `custom-${hash}`,
    ...(custom.apiKey === undefined ? {} : { apiKey: custom.apiKey }),
  };
}

/** The allowlist the proxy serves: the built-in layers and, when usable, the custom one. */
export function availableLayers(custom: CustomProvider | undefined): readonly TileLayerDef[] {
  const extra = custom === undefined ? null : customLayer(custom);
  return extra === null ? BUILTIN_LAYERS : [...BUILTIN_LAYERS, extra];
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

/** The upstream URL for one tile; the caller has checked the coordinates. */
export function tileUrl(layer: TileLayerDef, z: number, x: number, y: number): string {
  const subdomains = layer.subdomains ?? [];
  const values: Record<string, string> = {
    z: String(z),
    x: String(x),
    y: String(y),
    r: "",
    s: subdomains.length === 0 ? "" : (subdomains[(x + y) % subdomains.length] ?? ""),
    key: encodeURIComponent(layer.apiKey ?? ""),
  };
  return layer.url.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}
