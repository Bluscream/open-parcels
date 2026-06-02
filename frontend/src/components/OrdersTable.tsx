/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic API data */
import { RefreshCw, ShoppingBag, Hash, Calendar, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { getGuestToken } from "../utils/auth";

interface Order {
	id: number;
	source: string;
	orderNumber: string;
	status: string;
	createdAt: string;
	updatedAt: string;
}

function fmtDate(iso?: string) {
	if (!iso) return "—";
	return new Date(iso).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function OrderStatusTag({ status }: { status: string }) {
	const s = status.toLowerCase();
	let cls = "";
	if (s.includes("deliver") || s.includes("complet")) cls = "status-delivered";
	else if (s.includes("ship") || s.includes("sent")) cls = "status-shipped";
	else if (s.includes("process")) cls = "status-processing";
	else if (s.includes("return")) cls = "status-return-sent";
	else if (s.includes("order") || s.includes("pending")) cls = "status-ordered";
	else cls = "status-sent";

	return <span className={`status-tag ${cls}`}>{status}</span>;
}

export function OrdersTable({ onSelectOrder }: { onSelectOrder?: (id: number) => void }) {
	const [orders, setOrders] = useState<Order[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const token = getGuestToken();
			const res = await fetch("/api/v1/orders", {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const sorted = Array.isArray(data)
				? data.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
				: [];
			setOrders(sorted);
		} catch (e: any) {
			setError(e.message ?? "Failed to load orders");
		} finally {
			setLoading(false);
		}
	};

	const deleteOrder = async (id: number) => {
		if (!confirm("Are you sure you want to delete this order?")) return;
		try {
			const token = getGuestToken();
			const res = await fetch(`/api/v1/orders/${id}?token=${token}`, {
				method: "DELETE",
			});
			if (res.ok) {
				load();
			} else {
				alert("Failed to delete order");
			}
		} catch (err) {
			console.error(err);
			alert("Error deleting order");
		}
	};

	useEffect(() => {
		load();
	}, []);

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

			{error && <div className="table-error glass-panel">{error}</div>}

			<div className="glass-panel table-panel">
				<div className="table-wrapper">
					<table className="table">
						<thead>
							<tr>
								<th><Hash size={12} style={{display:"inline",marginRight:4}}/>ID</th>
								<th>Source</th>
								<th>Order Number</th>
								<th>Status</th>
								<th><Calendar size={12} style={{display:"inline",marginRight:4}}/>Created</th>
								<th>Updated</th>
								<th style={{ textAlign: "right" }}>Actions</th>
							</tr>
						</thead>
						<tbody>
							{loading && (
								<tr>
									<td colSpan={7} className="table-placeholder">
										<RefreshCw size={18} className="spin" /> Loading…
									</td>
								</tr>
							)}
							{!loading && orders.length === 0 && (
								<tr>
									<td colSpan={7} className="table-placeholder">No orders found.</td>
								</tr>
							)}
							{orders.map((o) => (
								<tr key={o.id} onClick={() => onSelectOrder?.(o.id)} style={{ cursor: onSelectOrder ? "pointer" : undefined }}>
									<td className="bold-cell mono">{o.id}</td>
									<td className="bold-cell">{o.source}</td>
									<td className="mono">{o.orderNumber}</td>
									<td><OrderStatusTag status={o.status} /></td>
									<td className="text-muted">{fmtDate(o.createdAt)}</td>
									<td className="text-muted">{fmtDate(o.updatedAt)}</td>
									<td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
										<button
											type="button"
											className="btn-icon-sm text-red"
											onClick={(e) => {
												e.stopPropagation();
												deleteOrder(o.id);
											}}
											title="Delete Order"
											style={{ display: "inline-flex", marginLeft: "auto" }}
										>
											<Trash2 size={14} />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
