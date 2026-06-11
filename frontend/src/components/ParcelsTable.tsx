/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic API data */
import { createColumnHelper } from "@tanstack/react-table";
import { Package, MapPin, Truck, Calendar, Hash, Edit2, Trash2, X, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getGuestToken } from "../utils/auth";
import { DataTable } from "./DataTable";

interface Parcel {
	id: number;
	trackingNumber: string;
	name?: string;
	courier?: string;
	status: string;
	lat?: number;
	lng?: number;
	estimatedDeliveryStart?: string;
	estimatedDeliveryEnd?: string;
	addedAt: string;
	updatedAt: string;
}

const STATUS_LABELS: Record<string, string> = {
	ordered: "Ordered",
	placed: "Placed",
	sent: "Dispatched",
	shipped: "Dispatched",
	arriving: "Arriving Today",
	pickup: "Ready for Pickup",
	delivered: "Delivered",
	return: "Return",
	"return-sent": "Return Sent",
	"return-accepted": "Return Accepted",
	unknown: "Syncing",
};

const ALL_STATUSES = ["ordered", "placed", "sent", "shipped", "arriving", "pickup", "delivered", "return-sent", "return-accepted", "unknown"];

function StatusTag({ status }: { status: string }) {
	const classMap: Record<string, string> = {
		ordered: "status-ordered",
		placed: "status-ordered",
		sent: "status-sent",
		shipped: "status-sent",
		arriving: "status-arriving",
		pickup: "status-arriving",
		delivered: "status-delivered",
		return: "status-return-sent",
		"return-sent": "status-return-sent",
		"return-accepted": "status-return-accepted",
		unknown: "status-syncing",
	};
	return (
		<span className={`status-tag ${classMap[status] ?? "status-syncing"}`}>
			{STATUS_LABELS[status] ?? status}
		</span>
	);
}

function fmtDate(iso?: string) {
	if (!iso) return "—";
	return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const formatDatetimeLocal = (dateStr: string | null | undefined) => {
	if (!dateStr) return "";
	try {
		const d = new Date(dateStr);
		if (Number.isNaN(d.getTime())) return "";
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	} catch { return ""; }
};

const ch = createColumnHelper<Parcel>();

export function ParcelsTable({ onSelectParcel }: { onSelectParcel?: (trackingNumber: string) => void }) {
	const [parcels, setParcels] = useState<Parcel[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [statusFilter, setStatusFilter] = useState("all");

	// Edit modal state
	const [showEditModal, setShowEditModal] = useState(false);
	const [editingParcelId, setEditingParcelId] = useState<number | null>(null);
	const [parcelForm, setParcelForm] = useState({
		trackingNumber: "", name: "", courier: "", status: "ordered",
		lat: "", lng: "", estimatedDeliveryStart: "", estimatedDeliveryEnd: "",
	});

	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/v1/parcels", { headers: { Authorization: `Bearer ${getGuestToken()}` } });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			setParcels(Array.isArray(data) ? data : []);
		} catch (e: any) {
			setError(e.message ?? "Failed to load parcels");
		} finally {
			setLoading(false);
		}
	};

	const openEdit = (p: Parcel) => {
		setEditingParcelId(p.id);
		setParcelForm({
			trackingNumber: p.trackingNumber || "", name: p.name || "", courier: p.courier || "",
			status: p.status || "ordered",
			lat: typeof p.lat === "number" ? String(p.lat) : "",
			lng: typeof p.lng === "number" ? String(p.lng) : "",
			estimatedDeliveryStart: formatDatetimeLocal(p.estimatedDeliveryStart),
			estimatedDeliveryEnd: formatDatetimeLocal(p.estimatedDeliveryEnd),
		});
		setShowEditModal(true);
	};

	const saveParcel = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!editingParcelId) return;
		try {
			const res = await fetch(`/api/v1/parcels/${editingParcelId}?token=${getGuestToken()}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					trackingNumber: parcelForm.trackingNumber,
					name: parcelForm.name || null,
					courier: parcelForm.courier || null,
					status: parcelForm.status,
					lat: parcelForm.lat ? parseFloat(parcelForm.lat) : null,
					lng: parcelForm.lng ? parseFloat(parcelForm.lng) : null,
					estimatedDeliveryStart: parcelForm.estimatedDeliveryStart ? new Date(parcelForm.estimatedDeliveryStart).toISOString() : null,
					estimatedDeliveryEnd: parcelForm.estimatedDeliveryEnd ? new Date(parcelForm.estimatedDeliveryEnd).toISOString() : null,
				}),
			});
			if (res.ok) { setShowEditModal(false); setEditingParcelId(null); load(); }
			else { const d = await res.json().catch(() => ({})); alert(`Error: ${d.error || "Unknown"}`); }
		} catch { alert("Error saving parcel"); }
	};

	const deleteParcel = async (id: number) => {
		if (!confirm("Delete this parcel and all its tracking events?")) return;
		const res = await fetch(`/api/v1/parcels/${id}?token=${getGuestToken()}`, { method: "DELETE" });
		if (res.ok) load(); else alert("Failed to delete parcel");
	};

	useEffect(() => {
		load();
		const handler = () => load();
		window.addEventListener("parcel-update", handler);
		return () => window.removeEventListener("parcel-update", handler);
	}, []);

	// Filter by status before passing to DataTable
	const filtered = statusFilter === "all" ? parcels : parcels.filter(p => p.status === statusFilter);

	const columns = [
		ch.accessor("id", {
			header: () => <><Hash size={12} style={{ display: "inline", marginRight: 4 }} />ID</>,
			cell: info => <span className="bold-cell mono">{info.getValue()}</span>,
			meta: { cellStyle: { width: "60px" } },
		}),
		ch.accessor("trackingNumber", {
			header: () => <><Package size={12} style={{ display: "inline", marginRight: 4 }} />Tracking Number</>,
			cell: info => <span className="bold-cell mono tracking-cell">{info.getValue()}</span>,
		}),
		ch.accessor("name", {
			header: "Name",
			cell: info => info.getValue() ?? <span className="text-muted">—</span>,
		}),
		ch.accessor("courier", {
			header: () => <><Truck size={12} style={{ display: "inline", marginRight: 4 }} />Courier</>,
			cell: info => info.getValue() ?? <span className="text-muted">—</span>,
		}),
		ch.accessor("status", {
			header: "Status",
			cell: info => <StatusTag status={info.getValue()} />,
		}),
		ch.display({
			id: "location",
			header: () => <><MapPin size={12} style={{ display: "inline", marginRight: 4 }} />Location</>,
			cell: ({ row }) => {
				const p = row.original;
				return p.lat != null && p.lng != null
					? <span className="text-muted coords-cell">{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</span>
					: <span className="text-muted">—</span>;
			},
			enableSorting: false,
		}),
		ch.accessor("estimatedDeliveryStart", {
			header: () => <><Calendar size={12} style={{ display: "inline", marginRight: 4 }} />Est. Delivery</>,
			cell: info => <span className="text-muted">{fmtDate(info.getValue())}</span>,
		}),
		ch.accessor("addedAt", {
			header: "Date Added",
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
				<div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }} onClick={e => e.stopPropagation()}>
					<button type="button" className="btn-icon-sm" onClick={e => { e.stopPropagation(); openEdit(row.original); }} title="Edit Parcel">
						<Edit2 size={13} />
					</button>
					<button type="button" className="btn-icon-sm text-red" onClick={e => { e.stopPropagation(); deleteParcel(row.original.id); }} title="Delete Parcel">
						<Trash2 size={13} />
					</button>
				</div>
			),
			enableSorting: false,
			meta: { headerStyle: { textAlign: "right" } },
		}),
	];

	const extraControls = (
		<select
			id="parcels-status-filter"
			className="table-filter-select"
			value={statusFilter}
			onChange={e => setStatusFilter(e.target.value)}
		>
			<option value="all">All statuses</option>
			{ALL_STATUSES.map(s => (
				<option key={s} value={s}>{STATUS_LABELS[s] ?? s}</option>
			))}
		</select>
	);

	return (
		<div className="table-page-container">
			<div className="table-page-header glass-panel">
				<div className="table-page-title-row">
					<Package size={22} className="table-page-icon" />
					<h1 className="table-page-title">Parcels</h1>
					<span className="table-page-count">{parcels.length}</span>
				</div>
				<button type="button" className="btn btn-sm" onClick={load} disabled={loading}>
					<RefreshCw size={14} className={loading ? "spin" : ""} />
					Refresh
				</button>
			</div>

			<DataTable
				columns={columns}
				data={filtered}
				loading={loading}
				error={error}
				emptyText="No parcels found."
				emptySearchText="No parcels match your search."
				searchPlaceholder="Search tracking number, name, courier, status…"
				extraControls={extraControls}
				defaultSortId="addedAt"
				defaultSortDesc
				totalCount={parcels.length}
				onRowClick={onSelectParcel ? (p) => onSelectParcel(p.trackingNumber) : undefined}
			/>

			{/* Edit Modal */}
			{showEditModal && (
				<div className="modal-overlay" onClick={() => setShowEditModal(false)}>
					<div className="glass-panel modal-card" onClick={e => e.stopPropagation()}>
						<div className="modal-header">
							<h3>Edit Parcel Details</h3>
							<button type="button" className="btn-icon-sm" onClick={() => setShowEditModal(false)}><X size={16} /></button>
						</div>
						<form onSubmit={saveParcel}>
							<div className="modal-body">
								<div className="form-group">
									<label className="label">Tracking Number *</label>
									<input type="text" className="input" value={parcelForm.trackingNumber} onChange={e => setParcelForm({ ...parcelForm, trackingNumber: e.target.value })} required />
								</div>
								<div className="form-group">
									<label className="label">Parcel Label / Name</label>
									<input type="text" className="input" value={parcelForm.name} onChange={e => setParcelForm({ ...parcelForm, name: e.target.value })} placeholder="e.g. Amazon Order" />
								</div>
								<div className="form-group">
									<label className="label">Courier Carrier</label>
									<input type="text" className="input" value={parcelForm.courier} onChange={e => setParcelForm({ ...parcelForm, courier: e.target.value })} placeholder="e.g. DHL" />
								</div>
								<div className="form-group">
									<label className="label">Status</label>
									<select className="select" value={parcelForm.status} onChange={e => setParcelForm({ ...parcelForm, status: e.target.value })}>
										<option value="ordered">Ordered</option>
										<option value="sent">Dispatched</option>
										<option value="arriving">Arriving Today</option>
										<option value="delivered">Delivered</option>
										<option value="return-sent">Return Sent</option>
										<option value="return-accepted">Return Accepted</option>
									</select>
								</div>
								<div className="form-row">
									<div className="form-group" style={{ flex: 1 }}>
										<label className="label">Est. Delivery Start</label>
										<input type="datetime-local" className="input" value={parcelForm.estimatedDeliveryStart} onChange={e => setParcelForm({ ...parcelForm, estimatedDeliveryStart: e.target.value })} />
									</div>
									<div className="form-group" style={{ flex: 1 }}>
										<label className="label">Est. Delivery End</label>
										<input type="datetime-local" className="input" value={parcelForm.estimatedDeliveryEnd} onChange={e => setParcelForm({ ...parcelForm, estimatedDeliveryEnd: e.target.value })} />
									</div>
								</div>
								<div className="form-row">
									<div className="form-group" style={{ flex: 1 }}>
										<label className="label">Latitude</label>
										<input type="number" step="0.0001" className="input" value={parcelForm.lat} onChange={e => setParcelForm({ ...parcelForm, lat: e.target.value })} />
									</div>
									<div className="form-group" style={{ flex: 1 }}>
										<label className="label">Longitude</label>
										<input type="number" step="0.0001" className="input" value={parcelForm.lng} onChange={e => setParcelForm({ ...parcelForm, lng: e.target.value })} />
									</div>
								</div>
							</div>
							<div className="modal-footer">
								<button type="button" className="btn" onClick={() => setShowEditModal(false)}>Cancel</button>
								<button type="submit" className="btn btn-primary">Save Changes</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
}
