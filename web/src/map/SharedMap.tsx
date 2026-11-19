import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, type ReactNode } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import { LayerControl } from "./LayerControl";
import { tileUrl, useMapStyle, type MapLayer } from "./layers";
import type { LatLng } from "./mapIcons";

/**
 * Tiles come through this server's own cache (`/tiles/<layer>/…`, see `layers.ts`): the tile
 * servers refuse browsers that strip the Referer, and the server identifies itself and caches as
 * their usage policies ask. Dark mode is a CSS filter on the tile pane (see `.map-dark`), left
 * off for satellite imagery, where inverted colours make no sense.
 */
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
  // Callers often build a new array on every render; only a change in the points refits.
  const key = JSON.stringify(bounds ?? []);
  useEffect(() => {
    const points = JSON.parse(key) as LatLng[];
    const fit = (): void => {
      if (userMoved.current) return;
      const valid = points.filter(([lat, lng]) => !Number.isNaN(lat) && !Number.isNaN(lng));
      if (valid.length > 0) {
        map.fitBounds(L.latLngBounds(valid), { padding: [50, 50], maxZoom, animate: false });
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
    // The split panels settle their sizes after the first paint; fit again once they have.
    const settled = setTimeout(() => {
      map.invalidateSize();
      fit();
    }, 300);
    return () => {
      clearTimeout(timer);
      clearTimeout(settled);
      observer.disconnect();
    };
  }, [map, key, maxZoom]);
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
  /** Fixed styles for a preview; no layer menu then. */
  readonly style?: { readonly base: MapLayer; readonly overlay: MapLayer | null };
}): ReactNode {
  const chosen = useMapStyle();
  const base = props.style?.base ?? chosen.base;
  const overlay = props.style === undefined ? chosen.overlay : props.style.overlay;
  const dark = prefersDark() && !base.satellite;
  return (
    <div
      className={dark ? "map-frame map-dark" : "map-frame"}
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
        {/* Keyed by layer: react-leaflet does not swap a TileLayer's URL or attribution. */}
        <TileLayer
          key={base.id}
          attribution={base.attribution}
          url={tileUrl(base.id)}
          maxNativeZoom={base.max_zoom}
          maxZoom={19}
        />
        {overlay === null ? null : (
          <TileLayer
            key={`overlay-${overlay.id}`}
            attribution={overlay.attribution}
            url={tileUrl(overlay.id)}
            maxNativeZoom={overlay.max_zoom}
            maxZoom={19}
            className="map-overlay-tiles"
            zIndex={2}
          />
        )}
        {props.children}
      </MapContainer>
      {props.style === undefined ? (
        <LayerControl
          layers={chosen.layers}
          base={base}
          overlay={overlay}
          onChoose={chosen.choose}
        />
      ) : null}
    </div>
  );
}
