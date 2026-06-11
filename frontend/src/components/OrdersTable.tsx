/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic API data */
import { createColumnHelper } from "@tanstack/react-table";
import { ShoppingBag, Hash, Calendar, Trash2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getGuestToken } from "../utils/auth";
import { DataTable } from "./DataTable";

interface Order {
	id: number;
	source: string;
	orderNumber: string;
	status: string;
	placedAt?: string;
	addedAt: string;
	updatedAt: string;
}

function fmtDate(iso?: string) {
	if (!iso) return "—";
	return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const ORDER_STATUS_LABELS: Record<string, string> = {
	placed: "Placed",
	confirmed: "Confirmed",
	ordered: "Ordered",
	shipped: "Dispatched",
	sent: "Dispatched",
	arriving: "Arriving Today",
	delivered: "Delivered",
	"return-sent": "Return Sent",
	"return-accepted": "Return Accepted",
	unknown: "Syncing",
};

const ORDER_STATUS_CLASS: Record<string, string> = {
	placed: "status-ordered",
	confirmed: "status-ordered",
	ordered: "status-ordered",
	shipped: "status-sent",
	sent: "status-sent",
	arriving: "status-arriving",
	delivered: "status-delivered",
	"return-sent": "status-return-sent",
	"return-accepted": "status-return-accepted",
	unknown: "status-syncing",
};

function OrderStatusTag({ status }: { status: string }) {
	const cls = ORDER_STATUS_CLASS[status] ?? "status-syncing";
	const label = ORDER_STATUS_LABELS[status] ?? status;
	return <span className={`status-tag ${cls}`}>{label}</span>;
}

const ch = createColumnHelper<Order>();

export function OrdersTable({ onSelectOrder }: { onSelectOrder?: (id: number) => void }) {
	const [orders, setOrders] = useState<Order[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/v1/orders", { headers: { Authorization: `Bearer ${getGuestToken()}` } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			setOrders(Array.isArray(data) ? data : []);
		} catch (e: any) {
			setError(e.message ?? "Failed to load orders");
		} finally {
			setLoading(false);
		}
	};

	const deleteOrder = async (id: number) => {
		if (!confirm("Delete this order?")) return;
		const res = await fetch(`/api/v1/orders/${id}?token=${getGuestToken()}`, { method: "DELETE" });
		if (res.ok) load(); else alert("Failed to delete order");
	};

	useEffect(() => { load(); }, []);

	const columns = [
		ch.accessor("id", {
			header: () => <><Hash size={12} style={{ display: "inline", marginRight: 4 }} />ID</>,
			cell: info => <span className="bold-cell mono">{info.getValue()}</span>,
			meta: { cellStyle: { width: "60px" } },
		}),
		ch.accessor("source", {
			header: "Source",
			cell: info => <span className="bold-cell">{info.getValue()}</span>,
		}),
		ch.accessor("orderNumber", {
			header: "Order Number",
			cell: info => <span className="mono">{info.getValue()}</span>,
		}),
		ch.accessor("status", {
			header: "Status",
			cell: info => <OrderStatusTag status={info.getValue()} />,
		}),
		ch.accessor("placedAt", {
			header: () => <><Calendar size={12} style={{ display: "inline", marginRight: 4 }} />Placed</>,
			cell: info => <span className="text-muted">{fmtDate(info.getValue())}</span>,
		}),
		ch.accessor("addedAt", {
			header: "Added",
			cell: info => <span className="text-muted">{fmtDate(info.getValue())}</span>,
		}),
		ch.accessor("updatedAt", {
			header: "Updated",
			cell: info => <span className="text-muted">{fmtDate(info.getValue())}</span>,
		}),
		ch.display({
			id: "actions",
			header: () => <span style={{ float: "right" }}>Actions</span>,
			cell: ({ row }) => (
				<div style={{ display: "flex", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
					<button
						type="button"
						className="btn-icon-sm text-red"
						onClick={e => { e.stopPropagation(); deleteOrder(row.original.id); }}
						title="Delete Order"
						style={{ display: "inline-flex" }}
					>
						<Trash2 size={14} />
					</button>
				</div>
			),
			enableSorting: false,
			meta: { headerStyle: { textAlign: "right" } },
		}),
	];

	return (
		<div className="table-page-container">
			<div className="table-page-header glass-panel">
				<div className="table-page-title-row">
					<ShoppingBag size={22} className="table-page-icon" />
					<h1 className="table-page-title">Orders</h1>
					<span className="table-page-count">{orders.length}</span>
				</div>
				<button type="button" className="btn btn-sm" onClick={load} disabled={loading}>
					<RefreshCw size={14} className={loading ? "spin" : ""} />
					Refresh
				</button>
			</div>

			<DataTable
				columns={columns}
				data={orders}
				loading={loading}
				error={error}
				emptyText="No orders found."
				emptySearchText="No orders match your search."
				searchPlaceholder="Search source, order number, status…"
				defaultSortId="placedAt"
				defaultSortDesc
				totalCount={orders.length}
				onRowClick={onSelectOrder ? (o) => onSelectOrder(o.id) : undefined}
			/>
		</div>
	);
}
