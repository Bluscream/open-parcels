/** One order: rename, archive or delete it, its items and its parcels. */
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ArrowLeft, RotateCcw, ShoppingBag, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { keys, useDeleteOrder, useOrder, useUpdateOrder } from "../api/queries";
import type { Order } from "../api/types";
import { ErrorNotice, Spinner } from "../components/ui";
import { formatDateTime } from "../lib/format";
import { InlineTitle, useCanEdit } from "../parcels/InlineEdit";
import { ItemList } from "../parcels/ItemList";
import { OrderBadges, OrderParcels, OrderProgress, orderSummary } from "./parts";

/** Says in words why the order is (or is not) in the archive. */
export function archiveExplanation(order: Order): string {
  switch (order.archive_mode) {
    case "archived":
      return "You archived this order. It stays archived until you restore it.";
    case "kept":
      return "You restored this order, so it stays out of the archive even once all its parcels are archived.";
    case "automatic":
      return order.archived
        ? "Archived automatically: all its parcels are archived."
        : "Archived automatically once all its parcels are archived. Delivered parcels are archived after the retention period.";
  }
}

function Actions({ order }: { readonly order: Order }): ReactNode {
  const canEdit = useCanEdit();
  const update = useUpdateOrder(order.id);
  const remove = useDeleteOrder();
  const client = useQueryClient();
  const navigate = useNavigate();
  if (!canEdit) return null;
  return (
    <>
      <button
        type="button"
        className="button small"
        aria-pressed={order.archived}
        disabled={update.isPending}
        onClick={() => {
          update.mutate({ archived: !order.archived });
        }}
      >
        {order.archived ? (
          <ArchiveRestore size={14} aria-hidden="true" />
        ) : (
          <Archive size={14} aria-hidden="true" />
        )}{" "}
        {order.archived ? "Unarchive" : "Archive"}
      </button>
      {order.archive_mode === "automatic" ? null : (
        <button
          type="button"
          className="button small"
          disabled={update.isPending}
          title="Let the order follow its parcels again"
          onClick={() => {
            update.mutate({ archived: null });
          }}
        >
          <RotateCcw size={14} aria-hidden="true" /> Archive automatically
        </button>
      )}
      <button
        type="button"
        className="button small danger"
        onClick={() => {
          const question =
            "Delete this order? Its parcels stay tracked, without the order. A shop that " +
            "lists the order again will not bring it back.";
          if (!window.confirm(question)) return;
          remove.mutate(order.id, {
            onSuccess: () => {
              void navigate({ to: "/orders" }).then(() => {
                client.removeQueries({ queryKey: keys.order(order.id), exact: true });
              });
            },
          });
        }}
      >
        <Trash2 size={14} aria-hidden="true" /> Delete
      </button>
      <ErrorNotice error={update.error ?? remove.error} />
    </>
  );
}

function Header({ order }: { readonly order: Order }): ReactNode {
  const update = useUpdateOrder(order.id);
  return (
    <div className="detail-head">
      <ShoppingBag size={40} className="page-icon" aria-hidden="true" />
      <div className="detail-head-text">
        <div className="muted">
          {order.shop} <span className="mono">{order.order_number}</span>
        </div>
        <InlineTitle
          titleId="order-title"
          shown={order.display_name}
          label={order.label}
          placeholder={`${order.shop} ${order.order_number}`}
          error={update.error}
          onSave={(label) => {
            update.mutate({ label });
          }}
        />
      </div>
      <div className="detail-head-tags">
        <OrderBadges order={order} />
      </div>
      <div className="detail-head-actions">
        <Actions order={order} />
      </div>
    </div>
  );
}

function Items({ order }: { readonly order: Order }): ReactNode {
  return (
    <section className="detail-section" aria-labelledby="order-items-title">
      <h2 id="order-items-title">Items</h2>
      {order.items.length === 0 ? (
        <p className="muted">The shop did not list the items.</p>
      ) : (
        <ItemList
          items={order.items}
          note={(_item, index) => {
            const parcelId = order.items[index]?.parcel_id ?? null;
            if (parcelId === null) return "Parcel not known yet";
            const carrying = order.parcels.find((parcel) => parcel.id === parcelId);
            return carrying === undefined ? null : `In ${carrying.display_name}`;
          }}
        />
      )}
    </section>
  );
}

export function OrderDetailPage({ orderId }: { readonly orderId: string }): ReactNode {
  const query = useOrder(orderId);
  const order = query.data;
  const summary = order === undefined ? "" : orderSummary(order);
  return (
    <section aria-labelledby="order-title" className="stack">
      <div className="detail-bar">
        <Link to="/orders" className="back-link">
          <ArrowLeft size={20} aria-hidden="true" /> All orders
        </Link>
      </div>
      <ErrorNotice error={query.error} />
      {order === undefined ? (
        query.isPending ? (
          <Spinner />
        ) : null
      ) : (
        <div className="glass-panel panel">
          <Header order={order} />
          {summary === "" ? null : <p className="muted">{summary}</p>}
          <OrderProgress order={order} />
          <p className="muted order-view-help">
            {archiveExplanation(order)}
            {order.archived_at === null ? null : ` Archived ${formatDateTime(order.archived_at)}.`}
          </p>
          <Items order={order} />
          <section className="detail-section" aria-labelledby="order-parcels-title">
            <h2 id="order-parcels-title">Parcels</h2>
            {order.parcels.length === 0 ? (
              <p className="muted">No parcel known yet.</p>
            ) : (
              <OrderParcels order={order} />
            )}
          </section>
        </div>
      )}
    </section>
  );
}
