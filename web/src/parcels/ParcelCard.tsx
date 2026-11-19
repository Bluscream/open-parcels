/** The original UI's parcel card: carrier tile, name, last carrier text, ETA and a status tag. */
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { Parcel } from "../api/types";
import { CarrierLogo } from "../components/CarrierLogo";
import { formatRelative, formatWindow } from "../lib/format";
import { LookupBadge, StatusBadge } from "./badges";

/** The parcel's name as the server gives it (label, item names or tracking code per Settings). */
export function parcelName(parcel: Pick<Parcel, "display_name">): string {
  return parcel.display_name;
}

/** "Expected Thu 20 Nov", "4 stops away", "Delivered 2 hours ago", or nothing. */
export function etaText(parcel: Parcel): string | null {
  if (parcel.delivered) {
    return `Delivered ${formatRelative(parcel.delivered_at)}`;
  }
  const stops = parcel.live?.stops_away;
  if (typeof stops === "number") {
    return stops === 0 ? "Next stop" : `${stops} stops away`;
  }
  if (parcel.planned_from === null && parcel.planned_to === null) {
    return null;
  }
  return `Expected ${formatWindow(parcel.planned_from, parcel.planned_to)}`;
}

export function ParcelCard({ parcel }: { readonly parcel: Parcel }): ReactNode {
  const eta = etaText(parcel);
  return (
    <Link to="/parcels/$parcelId" params={{ parcelId: parcel.id }} className="parcel-card">
      <CarrierLogo carrier={parcel.carrier} />
      <div className="parcel-card-body">
        <div className="parcel-card-title">{parcelName(parcel)}</div>
        <div className="parcel-card-meta">
          {parcel.raw_status ?? `${parcel.carrier} · ${parcel.barcode}`}
        </div>
        {eta === null ? null : <div className="parcel-card-eta">{eta}</div>}
      </div>
      {parcel.lookup.state === "not_found" ? (
        <LookupBadge state="not_found" />
      ) : (
        <StatusBadge status={parcel.status} manual={parcel.manual_status !== null} />
      )}
    </Link>
  );
}
