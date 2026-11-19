/**
 * Orders, as the original UI had them. The API has no order resource yet, so orders are grouped
 * from the `order` each parcel carries (shop plus order number).
 */
import { ShoppingBag } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useParcels } from "../api/queries";
import type { Parcel } from "../api/types";
import { ErrorNotice, Spinner } from "../components/ui";
import { ParcelCard } from "../parcels/ParcelCard";

interface Order {
  readonly key: string;
  readonly shop: string;
  readonly number: string;
  readonly parcels: Parcel[];
}

export function groupOrders(parcels: readonly Parcel[]): Order[] {
  const orders = new Map<string, Order>();
  for (const parcel of parcels) {
    if (parcel.order === null) {
      continue;
    }
    const key = `${parcel.order.shop}\u0000${parcel.order.order_number}`;
    const order = orders.get(key) ?? {
      key,
      shop: parcel.order.shop,
      number: parcel.order.order_number,
      parcels: [],
    };
    order.parcels.push(parcel);
    orders.set(key, order);
  }
  const newest = (order: Order): string =>
    order.parcels.reduce((max, p) => (p.updated_at > max ? p.updated_at : max), "");
  return [...orders.values()].sort((a, b) => newest(b).localeCompare(newest(a)));
}

function OrderCard({ order }: { readonly order: Order }): ReactNode {
  const delivered = order.parcels.filter((parcel) => parcel.delivered).length;
  const titleId = `order-${order.key.replace(/\W/g, "-")}`;
  return (
    <section className="glass-panel order-card" aria-labelledby={titleId}>
      <div className="order-head">
        <ShoppingBag size={20} className="page-icon" aria-hidden="true" />
        <h2 id={titleId}>
          {order.shop} <span className="mono muted">{order.number}</span>
        </h2>
      </div>
      <div>
        <div className="eta-label">
          {delivered} of {order.parcels.length} parcels delivered
        </div>
        <div
          className="order-progress"
          role="progressbar"
          aria-label="Delivered parcels"
          aria-valuemin={0}
          aria-valuemax={order.parcels.length}
          aria-valuenow={delivered}
        >
          <span style={{ width: `${(delivered / order.parcels.length) * 100}%` }} />
        </div>
      </div>
      <ul className="parcel-list">
        {order.parcels.map((parcel) => (
          <li key={parcel.id}>
            <ParcelCard parcel={parcel} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function OrdersPage(): ReactNode {
  const [archived, setArchived] = useState(false);
  const parcels = useParcels(archived);
  const orders = useMemo(() => groupOrders(parcels.data ?? []), [parcels.data]);

  return (
    <section aria-labelledby="orders-title" className="stack">
      <div className="page-header glass-panel">
        <div className="page-title-row">
          <ShoppingBag size={22} className="page-icon" aria-hidden="true" />
          <h1 id="orders-title">Orders</h1>
          <span className="page-count">{orders.length}</span>
        </div>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
            }}
          />
          Include archived
        </label>
      </div>
      <ErrorNotice error={parcels.error} />
      {parcels.data === undefined ? (
        <Spinner />
      ) : orders.length === 0 ? (
        <div className="glass-panel empty-state">
          <ShoppingBag size={32} aria-hidden="true" />
          <p>No orders yet. Parcels found through a shop source are grouped here by order.</p>
        </div>
      ) : (
        <div className="order-grid">
          {orders.map((order) => (
            <OrderCard key={order.key} order={order} />
          ))}
        </div>
      )}
    </section>
  );
}
