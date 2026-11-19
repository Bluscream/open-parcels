import { Link } from "@tanstack/react-router";
import { useMemo, type ReactNode } from "react";
import { Marker, Popup } from "react-leaflet";
import { useParcels } from "../api/queries";
import type { Parcel } from "../api/types";
import { ErrorNotice, Spinner } from "../components/ui";
import { formatRelative, STATUS_LABELS } from "../lib/format";
import { iconPackage, iconVan, type LatLng } from "./mapIcons";
import { SharedMap } from "./SharedMap";

interface Pin {
  readonly parcel: Parcel;
  readonly point: LatLng;
  readonly courier: boolean;
  readonly at: string | null;
}

const LIVE_STATES = new Set(["en_route", "next_stop"]);

/** The current courier position when a live session runs, else the parcel's last known place. */
function pinFor(parcel: Parcel): Pin | undefined {
  const live = parcel.live;
  if (
    live !== null &&
    LIVE_STATES.has(live.state) &&
    live.latitude !== null &&
    live.longitude !== null
  ) {
    return { parcel, point: [live.latitude, live.longitude], courier: true, at: live.position_at };
  }
  const location = parcel.location;
  return location === null
    ? undefined
    : {
        parcel,
        point: [location.latitude, location.longitude],
        courier: location.source === "courier",
        at: location.at,
      };
}

export default function MapPage(): ReactNode {
  const parcels = useParcels(false);
  const pins = useMemo(
    () =>
      (parcels.data ?? [])
        .filter((parcel) => !parcel.delivered)
        .map(pinFor)
        .filter((pin) => pin !== undefined),
    [parcels.data],
  );
  const bounds = useMemo(() => pins.map((pin) => pin.point), [pins]);
  const couriers = pins.filter((pin) => pin.courier).length;

  return (
    <section aria-labelledby="map-title" className="map-page">
      <div className="page-header">
        <h1 id="map-title">Map</h1>
        <p className="muted" role="status">
          {pins.length} parcels with a place, {couriers} live couriers
        </p>
      </div>
      <ErrorNotice error={parcels.error} />
      {parcels.isPending ? (
        <Spinner />
      ) : (
        <div className="map-large">
          <SharedMap label="Parcels on the map" bounds={bounds}>
            {pins.map((pin) => (
              <Marker
                key={pin.parcel.id}
                position={pin.point}
                icon={pin.courier ? iconVan : iconPackage}
                title={pin.parcel.label ?? pin.parcel.barcode}
              >
                <Popup>
                  <Link to="/parcels/$parcelId" params={{ parcelId: pin.parcel.id }}>
                    {pin.parcel.label ?? pin.parcel.barcode}
                  </Link>
                  <br />
                  {STATUS_LABELS[pin.parcel.status]}
                  {typeof pin.parcel.live?.stops_away === "number"
                    ? `, ${pin.parcel.live.stops_away} stops away`
                    : null}
                  <br />
                  <span className="muted">{formatRelative(pin.at)}</span>
                </Popup>
              </Marker>
            ))}
          </SharedMap>
        </div>
      )}
    </section>
  );
}
