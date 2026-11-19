import { MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { Marker, Popup } from "react-leaflet";
import type { ParcelDetail } from "../api/types";
import { formatDateTime } from "../lib/format";
import { useHome } from "../settings/home";
import { AnimatedRoute } from "./AnimatedRoute";
import {
  determineTransportMethod,
  generateCurvedPath,
  getTransportMarkerIcon,
  iconHome,
  iconIntermediate,
  iconSource,
  iconVan,
  type LatLng,
} from "./mapIcons";
import { SharedMap } from "./SharedMap";

interface Stop {
  readonly point: LatLng;
  readonly at: string;
  readonly label: string;
}

/** The scans that came with coordinates, oldest first, without repeats of the same place. */
function stopsOf(parcel: ParcelDetail): Stop[] {
  const stops: Stop[] = [];
  const sorted = [...parcel.history].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const entry of sorted) {
    if (entry.latitude === null || entry.longitude === null) continue;
    const previous = stops.at(-1);
    if (previous?.point[0] === entry.latitude && previous.point[1] === entry.longitude) continue;
    stops.push({
      point: [entry.latitude, entry.longitude],
      at: entry.timestamp,
      label: entry.location ?? entry.raw_status,
    });
  }
  return stops;
}

/**
 * The parcel's way on the detail page, as the original UI drew it: every placed scan, joined by a
 * curved animated line, then the live courier, then a fainter line for the way still ahead to the
 * home location (set on the Settings page).
 */
export default function LocationMap({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const { home } = useHome();
  // The React Compiler memoises these, so the animated lines only redraw when points change.
  const stops = stopsOf(parcel);
  const live = parcel.live;
  // Where the parcel is now comes from the server; a courier is one of its answers.
  const location = parcel.location;
  const courier: LatLng | null =
    location?.source === "courier" ? [location.latitude, location.longitude] : null;
  const travelled: LatLng[] = [
    ...stops.map((stop) => stop.point),
    ...(courier === null ? [] : [courier]),
  ];
  const current = travelled.at(-1) ?? null;
  const homePoint: LatLng | null = home === null ? null : [home.point[0], home.point[1]];

  const reachedPath = travelled.length > 1 ? generateCurvedPath(travelled) : null;
  // The way still ahead, to the home location, while the parcel is not delivered.
  const aheadPath =
    !parcel.delivered && current !== null && homePoint !== null
      ? generateCurvedPath([current, homePoint])
      : null;
  const bounds: LatLng[] = [...travelled, ...(homePoint === null ? [] : [homePoint])];

  if (current === null) {
    return (
      <div className="map-empty">
        <MapPin size={48} aria-hidden="true" />
        <h2>Location map not available</h2>
        <p>This parcel has no place on the map yet. Its updates still appear in the history.</p>
      </div>
    );
  }

  const transport =
    courier === null ? getTransportMarkerIcon(determineTransportMethod(parcel.history)) : iconVan;

  return (
    <div className="route-map">
      <SharedMap label="Parcel route" center={current} zoom={12} bounds={bounds}>
        {reachedPath === null ? null : <AnimatedRoute positions={reachedPath} color="#3b82f6" />}
        {aheadPath === null ? null : (
          <AnimatedRoute positions={aheadPath} color="#a78bfa" opacity={0.45} />
        )}
        {stops.map((stop, index) => {
          const last = index === stops.length - 1 && courier === null;
          return (
            <Marker
              key={`${stop.at}-${String(index)}`}
              position={stop.point}
              icon={last ? transport : index === 0 ? iconSource : iconIntermediate}
              zIndexOffset={last ? 1000 : 0}
            >
              <Popup>
                <div className="popup-content">
                  <strong>{stop.label}</strong>
                  <span className="muted">{formatDateTime(stop.at)}</span>
                </div>
              </Popup>
            </Marker>
          );
        })}
        {courier === null ? null : (
          <Marker position={courier} icon={iconVan} zIndexOffset={1000}>
            <Popup>
              <div className="popup-content">
                <strong>Courier</strong>
                <span className="muted">{formatDateTime(live?.position_at)}</span>
              </div>
            </Popup>
          </Marker>
        )}
        {homePoint === null ? null : (
          <Marker position={homePoint} icon={iconHome} zIndexOffset={-100}>
            <Popup>
              <div className="popup-content">
                <strong>Home</strong>
                {home?.label === null || home?.label === undefined ? null : (
                  <span className="muted">{home.label}</span>
                )}
              </div>
            </Popup>
          </Marker>
        )}
      </SharedMap>
    </div>
  );
}
