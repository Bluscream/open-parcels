import type { ReactNode } from "react";
import { Marker, Popup } from "react-leaflet";
import type { ParcelDetail } from "../api/types";
import { formatDateTime } from "../lib/format";
import { iconPackage, iconVan, type LatLng } from "./mapIcons";
import { SharedMap } from "./SharedMap";

type Location = NonNullable<ParcelDetail["location"]>;

/** One parcel's last known place, as a small map on the detail page. */
export default function LocationMap({ location }: { readonly location: Location }): ReactNode {
  const point: LatLng = [location.latitude, location.longitude];
  return (
    <SharedMap label="Parcel location" center={point} zoom={12} bounds={[point]}>
      <Marker position={point} icon={location.source === "courier" ? iconVan : iconPackage}>
        <Popup>
          {location.name ?? location.address ?? "Last known place"}
          <br />
          {formatDateTime(location.at)}
        </Popup>
      </Marker>
    </SharedMap>
  );
}
