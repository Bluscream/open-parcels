/** Pieces shared by the orders list and an order's page. */
import { Link } from "@tanstack/react-router";
import { MapPin } from "lucide-react";
import type { ReactNode } from "react";
import { apiUrl } from "../api/fetcher";
import type { Order, OrderStatus, OrderView, ParcelStatus } from "../api/types";
import { CarrierLogo } from "../components/CarrierLogo";
import { formatRelative, formatWindow } from "../lib/format";
import { ArchivedBadge, StatusBadge } from "../parcels/badges";

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  ordered: "Ordered",
  partly_shipped: "Partly shipped",
  shipped: "Shipped",
  partly_delivered: "Partly delivered",
  delivered: "Delivered",
  problem: "Problem",
};

/** The parcel status whose colour an order status borrows. */
const STATUS_COLOUR: Readonly<Record<OrderStatus, ParcelStatus>> = {
  ordered: "registered",
  partly_shipped: "in_transit",
  shipped: "in_transit",
  partly_delivered: "out_for_delivery",
  delivered: "delivered",
  problem: "problem",
};

/** The list's tabs, with what each one holds. */
export const ORDER_VIEW_TABS: readonly {
  readonly view: OrderView;
  readonly label: string;
  readonly help: string;
}[] = [
  {
    view: "open",
    label: "Open",
    help: "Orders still on their way: at least one parcel has not arrived yet.",
  },
  {
    view: "delivered",
    label: "Delivered",
    help:
      "Every parcel has arrived. Delivered parcels are archived after the retention period, " +
      "and an order moves to Archived once all its parcels are archived.",
  },
  {
    view: "archived",
    label: "Archived",
    help:
      "Orders whose parcels are all archived, orders that never got a parcel 30 days after " +
      "they were placed, and orders you archived yourself. Open one to bring it back.",
  },
];

export function OrderStatusBadge({ status }: { readonly status: OrderStatus }): ReactNode {
  return (
    <span className={`badge status-${STATUS_COLOUR[status]}`}>{ORDER_STATUS_LABELS[status]}</span>
  );
}

export function OrderBadges({ order }: { readonly order: Order }): ReactNode {
  return (
    <span className="order-badges">
      <OrderStatusBadge status={order.status} />
      {order.archived ? <ArchivedBadge /> : null}
    </span>
  );
}

export function formatTotal(total: Order["total"]): string | null {
  if (total === null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: total.currency }).format(
      total.amount,
    );
  } catch {
    return total.amount.toFixed(2);
  }
}

/** "Placed 3 days ago · 2 items · 39,90 €" */
export function orderSummary(order: Order): string {
  const total = formatTotal(order.total);
  const count = order.items.reduce((sum, item) => sum + (item.quantity ?? 1), 0);
  return [
    order.placed_at === null ? null : `Placed ${formatRelative(order.placed_at)}`,
    count === 0 ? null : `${String(count)} ${count === 1 ? "item" : "items"}`,
    total,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

export function OrderProgress({ order }: { readonly order: Order }): ReactNode {
  if (order.parcel_count === 0) {
    return <div className="eta-label">No parcel known yet</div>;
  }
  return (
    <div>
      <div className="eta-label">
        {order.delivered_count} of {order.parcel_count}{" "}
        {order.parcel_count === 1 ? "parcel" : "parcels"} delivered
      </div>
      <div
        className="order-progress"
        role="progressbar"
        aria-label="Delivered parcels"
        aria-valuemin={0}
        aria-valuemax={order.parcel_count}
        aria-valuenow={order.delivered_count}
      >
        <span style={{ width: `${(order.delivered_count / order.parcel_count) * 100}%` }} />
      </div>
    </div>
  );
}

/** Up to `limit` item pictures; the rest is counted. */
export function PictureGrid(props: { readonly order: Order; readonly limit: number }): ReactNode {
  const pictures = props.order.items.filter((item) => item.image_url !== null);
  if (pictures.length === 0) return null;
  const shown = pictures.slice(0, props.limit);
  const more = pictures.length - shown.length;
  return (
    <ul className="order-pictures" aria-label="Items">
      {shown.map((item, index) => (
        <li key={`${item.title}-${String(index)}`} title={item.title}>
          <img src={apiUrl(item.image_url ?? "")} alt={item.title} loading="lazy" />
        </li>
      ))}
      {more > 0 ? <li className="order-pictures-more">+{more}</li> : null}
    </ul>
  );
}

type OrderParcel = Order["parcels"][number];

function parcelLine(parcel: OrderParcel): string | null {
  if (parcel.delivered) return `Delivered ${formatRelative(parcel.delivered_at)}`;
  if (parcel.planned_from !== null || parcel.planned_to !== null) {
    return `Expected ${formatWindow(parcel.planned_from, parcel.planned_to)}`;
  }
  return null;
}

/** The order's parcels, each linking to its page, with status and where it is. */
export function OrderParcels({ order }: { readonly order: Order }): ReactNode {
  if (order.parcels.length === 0) return null;
  return (
    <ul className="parcel-list">
      {order.parcels.map((parcel) => {
        const line = parcelLine(parcel);
        const place = parcel.location?.name ?? null;
        return (
          <li key={parcel.id}>
            <Link to="/parcels/$parcelId" params={{ parcelId: parcel.id }} className="parcel-card">
              <CarrierLogo carrier={parcel.carrier} />
              <div className="parcel-card-body">
                <div className="parcel-card-title">{parcel.display_name}</div>
                <div className="parcel-card-meta">
                  {parcel.carrier} · {parcel.barcode}
                </div>
                {line === null ? null : <div className="parcel-card-eta">{line}</div>}
                {place === null || parcel.delivered ? null : (
                  <div className="parcel-card-meta">
                    <MapPin size={12} aria-hidden="true" /> {place}
                  </div>
                )}
              </div>
              <StatusBadge status={parcel.status} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
