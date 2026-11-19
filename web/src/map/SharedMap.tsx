import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, type ReactNode } from "react";
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

/**
 * Keeps the map sized to its container and fitted to the given points, until the user pans or
 * zooms: after that, new points (a courier moving) no longer pull the view back.
 */
function MapResizer({
  bounds,
  maxZoom,
}: {
  readonly bounds: readonly LatLng[] | undefined;
  readonly maxZoom: number;
}): null {
  const map = useMap();
  const userMoved = useRef(false);
  useEffect(() => {
    const container = map.getContainer();
    const moved = (): void => {
      userMoved.current = true;
    };
    map.on("dragstart", moved);
    container.addEventListener("wheel", moved, { passive: true });
    container.addEventListener("dblclick", moved);
    const zoomButtons = container.querySelector(".leaflet-control-zoom");
    zoomButtons?.addEventListener("click", moved);
    return () => {
      map.off("dragstart", moved);
      container.removeEventListener("wheel", moved);
      container.removeEventListener("dblclick", moved);
      zoomButtons?.removeEventListener("click", moved);
    };
  }, [map]);
  useEffect(() => {
    const fit = (): void => {
      if (userMoved.current) return;
      const valid = (bounds ?? []).filter(([lat, lng]) => !Number.isNaN(lat) && !Number.isNaN(lng));
      if (valid.length > 0) {
        map.fitBounds(L.latLngBounds(valid), { padding: [50, 50], maxZoom });
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
  }, [map, bounds, maxZoom]);
  return null;
}

export function SharedMap(props: {
  readonly bounds?: readonly LatLng[];
  /** How far fitting the bounds may zoom in (13 by default). */
  readonly fitMaxZoom?: number;
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
        // No further out than about one world wide; north and south stop at the tiles' edge.
        minZoom={2}
        maxBounds={[
          [-85, -540],
          [85, 540],
        ]}
        maxBoundsViscosity={1}
        scrollWheelZoom
        style={{ height: "100%", width: "100%", borderRadius: "12px", zIndex: 0 }}
      >
        <MapResizer bounds={props.bounds} maxZoom={props.fitMaxZoom ?? 13} />
        <TileLayer attribution={ATTRIBUTION} url={TILE_URL} maxZoom={19} />
        {props.children}
      </MapContainer>
    </div>
  );
}
