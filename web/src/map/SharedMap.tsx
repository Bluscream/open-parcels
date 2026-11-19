import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, type ReactNode } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import type { LatLng } from "./mapIcons";

const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';

function tileUrl(): string {
  const forced = document.documentElement.dataset["theme"];
  const dark =
    forced === undefined
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : forced === "dark";
  return `https://{s}.basemaps.cartocdn.com/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`;
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
    const observer = new ResizeObserver(() => {
      map.invalidateSize();
      setTimeout(fit, 10);
    });
    const container = map.getContainer();
    observer.observe(container);
    fit();
    return () => {
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
    <div className="map-frame" role="region" aria-label={props.label}>
      <MapContainer
        center={props.center ?? [51, 10]}
        zoom={props.zoom ?? 5}
        scrollWheelZoom
        style={{ height: "100%", width: "100%", borderRadius: "12px", zIndex: 0 }}
      >
        <MapResizer bounds={props.bounds} />
        <TileLayer attribution={ATTRIBUTION} url={tileUrl()} />
        {props.children}
      </MapContainer>
    </div>
  );
}
