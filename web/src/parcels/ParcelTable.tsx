import { Link } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { useMemo, useState, type ReactNode } from "react";
import type { Parcel } from "../api/types";
import { CarrierLogo } from "../components/CarrierLogo";
import { DataTable } from "../components/DataTable";
import { formatRelative, formatWindow } from "../lib/format";
import { ArchivedBadge, LookupBadge, StatusBadge } from "./badges";

export type ParcelFilter = "active" | "delivered" | "all";

const column = createColumnHelper<Parcel>();

/** Up to three item pictures beside the parcel name, as the original list showed them. */
export function ItemThumbs({ items }: { readonly items: Parcel["items"] }): ReactNode {
  const images = items.flatMap((item) => (item.image_url === null ? [] : [item.image_url]));
  if (images.length === 0) {
    return null;
  }
  return (
    <span className="thumbs">
      {images.slice(0, 3).map((src) => (
        <img key={src} src={src} alt="" loading="lazy" width={32} height={32} />
      ))}
    </span>
  );
}

const COLUMNS = [
  column.accessor((parcel) => parcel.display_name, {
    id: "label",
    header: "Parcel",
    cell: (info) => (
      <Link
        to="/parcels/$parcelId"
        params={{ parcelId: info.row.original.id }}
        className="row-link"
      >
        <CarrierLogo carrier={info.row.original.carrier} size={32} />
        <span className="cell-title">
          <strong>{info.getValue()}</strong>
          {info.row.original.label === null ? null : (
            <span className="mono"> {info.row.original.barcode}</span>
          )}
          {info.row.original.archived_at === null ? null : (
            <>
              {" "}
              <ArchivedBadge />
            </>
          )}
        </span>
        <ItemThumbs items={info.row.original.items} />
      </Link>
    ),
  }),
  column.accessor("status", {
    header: "Status",
    // `status` is already the effective one: a manual status wins on the server.
    cell: (info) => (
      <StatusBadge status={info.getValue()} manual={info.row.original.manual_status !== null} />
    ),
    filterFn: "equalsString",
  }),
  column.accessor((parcel) => parcel.lookup.state, {
    id: "lookup",
    header: "Carrier lookup",
    cell: (info) => <LookupBadge state={info.getValue()} />,
  }),
  column.accessor("carrier", { header: "Carrier" }),
  column.accessor((parcel) => parcel.planned_from ?? parcel.planned_to ?? "", {
    id: "eta",
    header: "Expected",
    cell: (info) => formatWindow(info.row.original.planned_from, info.row.original.planned_to),
  }),
  column.accessor("updated_at", {
    header: "Last update",
    cell: (info) => <time dateTime={info.getValue()}>{formatRelative(info.getValue())}</time>,
  }),
];

function matchesFilter(parcel: Parcel, filter: ParcelFilter): boolean {
  if (filter === "all") {
    return true;
  }
  return filter === "delivered" ? parcel.delivered : !parcel.delivered;
}

/**
 * The parcel list. The Show filter is owned by the page, so it survives the table being
 * re-rendered with another data set (archived parcels included or not).
 */
export function ParcelTable(props: {
  readonly parcels: Parcel[];
  readonly filter: ParcelFilter;
  readonly onFilterChange: (filter: ParcelFilter) => void;
}): ReactNode {
  const { filter, onFilterChange: setFilter } = props;
  const [carrier, setCarrier] = useState("");
  const carriers = useMemo(
    () => [...new Set(props.parcels.map((parcel) => parcel.carrier))].sort(),
    [props.parcels],
  );
  const rows = useMemo(
    () =>
      props.parcels.filter(
        (parcel) => matchesFilter(parcel, filter) && (carrier === "" || parcel.carrier === carrier),
      ),
    [props.parcels, filter, carrier],
  );

  const controls = (
    <>
      <fieldset className="segmented">
        <legend className="visually-hidden">Show</legend>
        {(["active", "delivered", "all"] as const).map((value) => (
          <label key={value} className={filter === value ? "selected" : undefined}>
            <input
              type="radio"
              name="parcel-filter"
              value={value}
              checked={filter === value}
              onChange={() => {
                setFilter(value);
              }}
            />
            {value === "active" ? "Active" : value === "delivered" ? "Delivered" : "All"}
          </label>
        ))}
      </fieldset>
      <label>
        <span className="visually-hidden">Carrier</span>
        <select
          value={carrier}
          onChange={(e) => {
            setCarrier(e.target.value);
          }}
        >
          <option value="">All carriers</option>
          {carriers.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      </label>
    </>
  );

  return (
    <DataTable
      caption="Parcels"
      columns={COLUMNS}
      data={rows}
      searchLabel="Search parcels"
      extraControls={controls}
      defaultSort={[{ id: "updated_at", desc: true }]}
      emptyText={filter === "active" ? "No parcels on the way." : "No parcels."}
      rowClassName={(parcel) => (parcel.lookup.state === "not_found" ? "row-warning" : undefined)}
    />
  );
}
