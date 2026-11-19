import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, type ReactNode } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import type { LatLng } from "./mapIcons";

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * OpenStreetMap tiles through this server's own cache (`/tiles/…`): the tile servers refuse
 * browsers that strip the Referer, and the server identifies itself and caches as OSM's tile
 * usage policy asks. Resolved against the base URI so it also works under HA ingress. Dark mode
 * is a CSS filter on the tile pane (see `.map-dark`).
 */
const TILE_URL = `${new URL("tiles/", document.baseURI).toString()}{z}/{x}/{y}.png`;

function prefersDark(): boolean {
  const forced = document.documentElement.dataset["theme"];
  return forced === undefined
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : forced === "dark";
}

/** Keeps the map sized to its container and fitted to the given points. */
function MapResizer({ bounds }: { readonly bounds: readonly LatLng[] | undefined }): null {
  const map = useMap();
  useEffect(() => {
    const fit = (): void => {
      const valid = (bounds ?? []).filter(([lat, lng]) => !Number.isNaN(lat) && !Number.isNaN(lng));
      if (valid.length > 0) {
        map.fitBounds(L.latLngBounds(valid), { padding: [50, 50], maxZoom: 13 });
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      clearTimeout(timer);
      timer = setTimeout(fit, 10);
    });
    const container = map.getContainer();
    observer.observe(container);
    fit();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [map, bounds]);
  return null;
}

export function SharedMap(props: {
  readonly bounds?: readonly LatLng[];
  readonly center?: LatLng;
  readonly zoom?: number;
  readonly label: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <div
      className={prefersDark() ? "map-frame map-dark" : "map-frame"}
      role="region"
      aria-label={props.label}
    >
      <MapContainer
        center={props.center ?? [51, 10]}
        zoom={props.zoom ?? 5}
        scrollWheelZoom
        style={{ height: "100%", width: "100%", borderRadius: "12px", zIndex: 0 }}
      >
        <MapResizer bounds={props.bounds} />
        <TileLayer attribution={ATTRIBUTION} url={TILE_URL} maxZoom={19} />
        {props.children}
      </MapContainer>
    </div>
  );
}
