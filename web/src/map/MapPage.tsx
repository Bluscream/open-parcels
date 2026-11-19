import { Link } from "@tanstack/react-router";
import { PackageOpen } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Marker, Popup } from "react-leaflet";
import { useParcels } from "../api/queries";
import type { Parcel } from "../api/types";
import { SplitContainer } from "../components/SplitContainer";
import { ErrorNotice, Spinner } from "../components/ui";
import { boundsAround } from "../lib/geo";
import { formatRelative, STATUS_LABELS } from "../lib/format";
import { useHome } from "../settings/home";
import { ParcelCard, parcelName } from "../parcels/ParcelCard";
import { AnimatedRoute } from "./AnimatedRoute";
import {
  determineTransportMethod,
  generateCurvedPath,
  getTransportMarkerIcon,
  iconHome,
  iconSource,
  iconVan,
} from "./mapIcons";
import { pinFor, type Pin } from "./pins";
import { PopupMeta } from "./PopupMeta";
import { SharedMap } from "./SharedMap";

function PinMarker({ pin }: { readonly pin: Pin }): ReactNode {
  const icon = pin.courier
    ? iconVan
    : getTransportMarkerIcon(determineTransportMethod(pin.parcel.history));
  const route = useMemo(
    () => (pin.from === null ? null : generateCurvedPath([pin.from, pin.point])),
    [pin.from, pin.point],
  );
  return (
    <>
      {route === null || pin.from === null ? null : (
        <>
          <AnimatedRoute positions={route} color="#a78bfa" />
          <Marker position={pin.from} icon={iconSource} title="Last carrier scan" />
        </>
      )}
      <Marker position={pin.point} icon={icon} title={parcelName(pin.parcel)} zIndexOffset={1000}>
        <Popup>
          <div className="popup-content">
            <Link to="/parcels/$parcelId" params={{ parcelId: pin.parcel.id }}>
              {parcelName(pin.parcel)}
            </Link>
            <span className="muted">{pin.parcel.carrier}</span>
            <span>
              {pin.parcel.raw_status ?? STATUS_LABELS[pin.parcel.status]}
              {typeof pin.parcel.live?.stops_away === "number"
                ? `, ${pin.parcel.live.stops_away} stops away`
                : null}
            </span>
            <PopupMeta when={formatRelative(pin.at)} point={pin.point} />
          </div>
        </Popup>
      </Marker>
    </>
  );
}

function TransitList({ parcels }: { readonly parcels: readonly Parcel[] }): ReactNode {
  return (
    <section className="glass-panel panel" aria-labelledby="transit-title">
      <h2 id="transit-title">Parcels in transit</h2>
      {parcels.length === 0 ? (
        <div className="empty-state">
          <PackageOpen size={32} aria-hidden="true" />
          <p>No active parcels in transit.</p>
        </div>
      ) : (
        <ul className="parcel-list">
          {parcels.map((parcel) => (
            <li key={parcel.id}>
              <ParcelCard parcel={parcel} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function MapPage(): ReactNode {
  const parcels = useParcels(false);
  const active = useMemo(
    () => (parcels.data ?? []).filter((parcel) => !parcel.delivered),
    [parcels.data],
  );
  const pins = useMemo(() => active.map(pinFor).filter((pin) => pin !== undefined), [active]);
  const { home } = useHome();
  const homePoint = home?.point;
  // With a home location, it sits in the middle and the view widens until every parcel fits.
  const bounds = useMemo(() => {
    const points = pins.flatMap((pin) => (pin.from === null ? [pin.point] : [pin.point, pin.from]));
    return homePoint === undefined ? points : boundsAround(homePoint, points);
  }, [pins, homePoint]);
  const couriers = pins.filter((pin) => pin.courier).length;

  return (
    <section aria-labelledby="map-title" className="stack">
      <h1 id="map-title" className="visually-hidden">
        Live map
      </h1>
      <p className="visually-hidden" role="status">
        {pins.length} parcels with a place, {couriers} live couriers
      </p>
      <ErrorNotice error={parcels.error} />
      {parcels.isPending ? (
        <Spinner />
      ) : (
        <div className="split-page">
          <SplitContainer
            leftDefaultSize={70}
            leftMinSize={40}
            rightDefaultSize={30}
            rightMinSize={20}
            leftPanel={
              <div className="glass-panel map-panel">
                <SharedMap
                  label="Parcels on the map"
                  bounds={bounds}
                  {...(homePoint === undefined ? {} : { center: homePoint, zoom: 12 })}
                >
                  {homePoint === undefined ? null : (
                    <Marker position={homePoint} icon={iconHome} title="Home" zIndexOffset={-100}>
                      <Popup>
                        <strong>Home</strong>
                        {home?.label === null || home?.label === undefined ? null : (
                          <div className="muted">{home.label}</div>
                        )}
                      </Popup>
                    </Marker>
                  )}
                  {pins.map((pin) => (
                    <PinMarker key={pin.parcel.id} pin={pin} />
                  ))}
                </SharedMap>
              </div>
            }
            rightPanel={<TransitList parcels={active} />}
          />
        </div>
      )}
    </section>
  );
}
