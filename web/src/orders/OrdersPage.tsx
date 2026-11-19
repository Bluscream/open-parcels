/** Orders from shop sources and mails, sorted into open, delivered and archived. */
import { Link } from "@tanstack/react-router";
import { ShoppingBag } from "lucide-react";
import type { ReactNode } from "react";
import { pickOne, useUrlParam } from "../lib/urlState";
import { useOrders } from "../api/queries";
import type { Order, OrderView } from "../api/types";
import { ErrorNotice, Spinner } from "../components/ui";
import {
  OrderBadges,
  OrderParcels,
  OrderProgress,
  orderSummary,
  ORDER_VIEW_TABS,
  PictureGrid,
} from "./parts";

function OrderCard({ order }: { readonly order: Order }): ReactNode {
  const titleId = `order-${order.id}`;
  const summary = orderSummary(order);
  return (
    <section className="glass-panel order-card" aria-labelledby={titleId}>
      <div className="order-head">
        <ShoppingBag size={20} className="page-icon" aria-hidden="true" />
        <div className="order-head-text">
          <h2 id={titleId}>
            <Link to="/orders/$orderId" params={{ orderId: order.id }}>
              {order.label ?? order.shop}
            </Link>
          </h2>
          <span className="mono muted">
            {order.label === null ? order.order_number : `${order.shop} ${order.order_number}`}
          </span>
        </div>
        <OrderBadges order={order} />
      </div>
      {summary === "" ? null : <div className="muted">{summary}</div>}
      <PictureGrid order={order} limit={6} />
      <OrderProgress order={order} />
      <OrderParcels order={order} />
    </section>
  );
}

const EMPTY: Readonly<Record<OrderView, string>> = {
  open: "No open orders. Orders found through a shop source or an order mail show up here.",
  delivered: "No delivered orders that are not archived yet.",
  archived: "Nothing archived yet.",
  all: "No orders yet.",
};

const VIEWS: readonly OrderView[] = ["open", "delivered", "archived", "all"];

/** Linkable: `?view=open|delivered|archived|all`. */
export function OrdersPage(): ReactNode {
  const [viewParam, setViewParam] = useUrlParam("view");
  const view = pickOne(viewParam, VIEWS, "open");
  const setView = (next: OrderView): void => {
    setViewParam(next === "open" ? null : next);
  };
  const orders = useOrders(view);
  const tab = ORDER_VIEW_TABS.find((entry) => entry.view === view);

  return (
    <section aria-labelledby="orders-title" className="stack">
      <div className="page-header glass-panel">
        <div className="page-title-row">
          <ShoppingBag size={22} className="page-icon" aria-hidden="true" />
          <h1 id="orders-title">Orders</h1>
          <span className="page-count">{orders.data?.length ?? 0}</span>
        </div>
        <fieldset className="segmented">
          <legend className="visually-hidden">Show</legend>
          {ORDER_VIEW_TABS.map((entry) => (
            <label key={entry.view} className={view === entry.view ? "selected" : undefined}>
              <input
                type="radio"
                name="order-view"
                value={entry.view}
                checked={view === entry.view}
                onChange={() => {
                  setView(entry.view);
                }}
              />
              {entry.label}
            </label>
          ))}
        </fieldset>
      </div>
      {tab === undefined ? null : <p className="muted order-view-help">{tab.help}</p>}
      <ErrorNotice error={orders.error} />
      {orders.data === undefined ? (
        orders.isPending ? (
          <Spinner />
        ) : null
      ) : orders.data.length === 0 ? (
        <div className="glass-panel empty-state">
          <ShoppingBag size={32} aria-hidden="true" />
          <p>{EMPTY[view]}</p>
        </div>
      ) : (
        <div className="order-grid">
          {orders.data.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </div>
      )}
    </section>
  );
}
