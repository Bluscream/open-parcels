import { MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { Marker, Popup } from "react-leaflet";
import type { ParcelDetail } from "../api/types";
import { formatDateTime } from "../lib/format";
import { AnimatedRoute } from "./AnimatedRoute";
import {
  determineTransportMethod,
  generateCurvedPath,
  getTransportMarkerIcon,
  iconSource,
  iconVan,
  type LatLng,
} from "./mapIcons";
import { pinFor } from "./pins";
import { SharedMap } from "./SharedMap";

/** The parcel's place on the detail page: last carrier scan, and the courier when one is live. */
export default function LocationMap({ parcel }: { readonly parcel: ParcelDetail }): ReactNode {
  const pin = pinFor(parcel);
  // The React Compiler memoises this, so AnimatedRoute only redraws when the points change.
  const route =
    pin === undefined || pin.from === null ? null : generateCurvedPath([pin.from, pin.point]);
  if (pin === undefined) {
    return (
      <div className="map-empty">
        <MapPin size={48} aria-hidden="true" />
        <h2>Location map not available</h2>
        <p>This parcel has no place on the map yet. Its updates still appear in the history.</p>
      </div>
    );
  }
  const bounds: LatLng[] = pin.from === null ? [pin.point] : [pin.from, pin.point];
  const location = parcel.location;
  return (
    <SharedMap label="Parcel location" center={pin.point} zoom={12} bounds={bounds}>
      {route === null || pin.from === null ? null : (
        <>
          <AnimatedRoute positions={route} color="#a78bfa" />
          <Marker position={pin.from} icon={iconSource}>
            <Popup>Last carrier scan, {formatDateTime(location?.at)}</Popup>
          </Marker>
        </>
      )}
      <Marker
        position={pin.point}
        icon={
          pin.courier ? iconVan : getTransportMarkerIcon(determineTransportMethod(parcel.history))
        }
        zIndexOffset={1000}
      >
        <Popup>
          <div className="popup-content">
            <strong>
              {pin.courier
                ? "Courier"
                : (location?.name ?? location?.address ?? "Last known place")}
            </strong>
            <span className="muted">{formatDateTime(pin.at)}</span>
          </div>
        </Popup>
      </Marker>
    </SharedMap>
  );
}
