import type { ReactNode } from "react";
import { distanceKm, formatDistance } from "../lib/geo";
import { useHome } from "../settings/home";
import type { LatLng } from "./mapIcons";

/** The place on OpenStreetMap, with a marker, in a new tab. */
export function mapLink(point: LatLng): string {
  const [lat, lng] = point.map((value) => value.toFixed(5));
  return `https://www.openstreetmap.org/?mlat=${lat ?? ""}&mlon=${lng ?? ""}#map=14/${lat ?? ""}/${lng ?? ""}`;
}

/**
 * The muted line under a map popup: when, then how far from home with a link to the place
 * ("2 minutes ago · 546 km away"). Without a home location only the link to the place shows.
 */
export function PopupMeta(props: { readonly when: string; readonly point: LatLng }): ReactNode {
  const { home } = useHome();
  const label =
    home === null
      ? "Open map"
      : `${formatDistance(distanceKm([home.point[0], home.point[1]], props.point))} away`;
  return (
    <span className="muted">
      {props.when} ·{" "}
      <a href={mapLink(props.point)} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    </span>
  );
}
