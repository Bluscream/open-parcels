/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic API data */
import { RefreshCw, Package, MapPin, Truck, Calendar, Hash, Edit2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getGuestToken } from "../utils/auth";

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
	createdAt: string;
	updatedAt: string;
}

const STATUS_LABELS: Record<string, string> = {
	ordered: "Ordered",
	sent: "Dispatched",
	arriving: "Arriving",
	delivered: "Delivered",
	return: "Return",
};

function StatusTag({ status }: { status: string }) {
	const classMap: Record<string, string> = {
		ordered: "status-ordered",
		sent: "status-sent",
		arriving: "status-arriving",
		delivered: "status-delivered",
		return: "status-return-sent",
	};
	return (
		<span className={`status-tag ${classMap[status] ?? ""}`}>
			{STATUS_LABELS[status] ?? status}
		</span>
	);
}

function fmtDate(iso?: string) {
	if (!iso) return "—";
	return new Date(iso).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

export function ParcelsTable({ onSelectParcel }: { onSelectParcel?: (trackingNumber: string) => void }) {
	const [parcels, setParcels] = useState<Parcel[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const token = getGuestToken();
			const res = await fetch("/api/v1/parcels", {
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			const sorted = Array.isArray(data)
				? data.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
				: [];
			setParcels(sorted);
		} catch (e: any) {
			setError(e.message ?? "Failed to load parcels");
		} finally {
			setLoading(false);
		}
	};

	const [showEditModal, setShowEditModal] = useState<boolean>(false);
	const [editingParcelId, setEditingParcelId] = useState<number | null>(null);
	const [parcelForm, setParcelForm] = useState({
		trackingNumber: "",
		name: "",
		courier: "",
		status: "ordered",
		lat: "",
		lng: "",
		estimatedDeliveryStart: "",
		estimatedDeliveryEnd: "",
	});

	const formatDatetimeLocal = (dateStr: string | null | undefined) => {
		if (!dateStr) return "";
		try {
			const d = new Date(dateStr);
			if (Number.isNaN(d.getTime())) return "";
			const year = d.getFullYear();
			const month = String(d.getMonth() + 1).padStart(2, "0");
			const day = String(d.getDate()).padStart(2, "0");
			const hours = String(d.getHours()).padStart(2, "0");
			const minutes = String(d.getMinutes()).padStart(2, "0");
			return `${year}-${month}-${day}T${hours}:${minutes}`;
		} catch {
			return "";
		}
	};

	const openEditParcel = (parcel: Parcel) => {
		setEditingParcelId(parcel.id);
		setParcelForm({
			trackingNumber: parcel.trackingNumber || "",
			name: parcel.name || "",
			courier: parcel.courier || "",
			status: parcel.status || "ordered",
			lat: typeof parcel.lat === "number" ? parcel.lat.toString() : "",
			lng: typeof parcel.lng === "number" ? parcel.lng.toString() : "",
			estimatedDeliveryStart: formatDatetimeLocal(parcel.estimatedDeliveryStart),
			estimatedDeliveryEnd: formatDatetimeLocal(parcel.estimatedDeliveryEnd),
		});
		setShowEditModal(true);
	};

	const saveParcel = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!editingParcelId) return;
		try {
			const token = getGuestToken();
			const res = await fetch(`/api/v1/parcels/${editingParcelId}?token=${token}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					trackingNumber: parcelForm.trackingNumber,
					name: parcelForm.name || null,
					courier: parcelForm.courier || null,
					status: parcelForm.status,
					lat: parcelForm.lat ? parseFloat(parcelForm.lat) : null,
					lng: parcelForm.lng ? parseFloat(parcelForm.lng) : null,
					estimatedDeliveryStart: parcelForm.estimatedDeliveryStart
						? new Date(parcelForm.estimatedDeliveryStart).toISOString()
						: null,
					estimatedDeliveryEnd: parcelForm.estimatedDeliveryEnd
						? new Date(parcelForm.estimatedDeliveryEnd).toISOString()
						: null,
				}),
			});

			if (res.ok) {
				setShowEditModal(false);
				setEditingParcelId(null);
				load();
			} else {
				const errData = await res.json().catch(() => ({}));
				alert(`Error saving parcel: ${errData.error || "Unknown error"}`);
			}
		} catch (err) {
			console.error(err);
			alert("Error saving parcel");
		}
	};

	const deleteParcel = async (id: number) => {
		if (!confirm("Are you sure you want to delete this parcel? All tracking events will also be deleted.")) return;
		try {
			const token = getGuestToken();
			const res = await fetch(`/api/v1/parcels/${id}?token=${token}`, {
				method: "DELETE",
			});
			if (res.ok) {
				load();
			} else {
				alert("Failed to delete parcel");
			}
		} catch (err) {
			console.error(err);
			alert("Error deleting parcel");
		}
	};

	useEffect(() => {
		load();

		const handler = () => load();
		window.addEventListener("parcel-update", handler);
		return () => window.removeEventListener("parcel-update", handler);
	}, []);

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

			{error && <div className="table-error glass-panel">{error}</div>}

			<div className="glass-panel table-panel">
				<div className="table-wrapper">
					<table className="table">
						<thead>
							<tr>
								<th><Hash size={12} style={{display:"inline",marginRight:4}}/>ID</th>
								<th><Package size={12} style={{display:"inline",marginRight:4}}/>Tracking Number</th>
								<th>Name</th>
								<th><Truck size={12} style={{display:"inline",marginRight:4}}/>Courier</th>
								<th>Status</th>
								<th><MapPin size={12} style={{display:"inline",marginRight:4}}/>Location</th>
								<th><Calendar size={12} style={{display:"inline",marginRight:4}}/>Est. Delivery</th>
								<th>Date Added</th>
								<th>Updated</th>
								<th style={{ textAlign: "right" }}>Actions</th>
							</tr>
						</thead>
						<tbody>
							{loading && (
								<tr>
									<td colSpan={10} className="table-placeholder">
										<RefreshCw size={18} className="spin" /> Loading…
									</td>
								</tr>
							)}
							{!loading && parcels.length === 0 && (
								<tr>
									<td colSpan={10} className="table-placeholder">No parcels found.</td>
								</tr>
							)}
							{parcels.map((p) => (
								<tr key={p.id} onClick={() => onSelectParcel?.(p.trackingNumber)}>
									<td className="bold-cell mono">{p.id}</td>
									<td className="bold-cell mono tracking-cell">{p.trackingNumber}</td>
									<td>{p.name ?? <span className="text-muted">—</span>}</td>
									<td>{p.courier ?? <span className="text-muted">—</span>}</td>
									<td><StatusTag status={p.status} /></td>
									<td className="text-muted coords-cell">
										{p.lat != null && p.lng != null
											? `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`
											: "—"}
									</td>
									<td className="text-muted">{fmtDate(p.estimatedDeliveryStart)}</td>
									<td className="text-muted">{fmtDate(p.createdAt)}</td>
									<td className="text-muted">{fmtDate(p.updatedAt)}</td>
									<td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
										<div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
											<button
												type="button"
												className="btn-icon-sm"
												onClick={(e) => {
													e.stopPropagation();
													openEditParcel(p);
												}}
												title="Edit Parcel"
											>
												<Edit2 size={13} />
											</button>
											<button
												type="button"
												className="btn-icon-sm text-red"
												onClick={(e) => {
													e.stopPropagation();
													deleteParcel(p.id);
												}}
												title="Delete Parcel"
											>
												<Trash2 size={13} />
											</button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>

					{showEditModal && (
						<div className="modal-overlay" onClick={() => setShowEditModal(false)}>
							<div className="glass-panel modal-card" onClick={(e) => e.stopPropagation()}>
								<div className="modal-header">
									<h3>Edit Parcel Details</h3>
									<button
										type="button"
										className="btn-icon-sm"
										onClick={() => setShowEditModal(false)}
									>
										<X size={16} />
									</button>
								</div>
								<form onSubmit={saveParcel}>
									<div className="modal-body">
										<div className="form-group">
											<label className="label">Tracking Number *</label>
											<input
												type="text"
												className="input"
												value={parcelForm.trackingNumber}
												onChange={(e) =>
													setParcelForm({
														...parcelForm,
														trackingNumber: e.target.value,
													})
												}
												required
											/>
										</div>
										<div className="form-group">
											<label className="label">Parcel Label / Name</label>
											<input
												type="text"
												className="input"
												value={parcelForm.name}
												onChange={(e) =>
													setParcelForm({
														...parcelForm,
														name: e.target.value,
													})
												}
												placeholder="e.g. Amazon Order"
											/>
										</div>
										<div className="form-group">
											<label className="label">Courier Carrier</label>
											<input
												type="text"
												className="input"
												value={parcelForm.courier}
												onChange={(e) =>
													setParcelForm({ ...parcelForm, courier: e.target.value })
												}
												placeholder="e.g. DHL"
											/>
										</div>
										<div className="form-group">
											<label className="label">Status</label>
											<select
												className="select"
												value={parcelForm.status}
												onChange={(e) =>
													setParcelForm({ ...parcelForm, status: e.target.value })
												}
											>
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
												<input
													type="datetime-local"
													className="input"
													value={parcelForm.estimatedDeliveryStart}
													onChange={(e) =>
														setParcelForm({
															...parcelForm,
															estimatedDeliveryStart: e.target.value,
														})
													}
												/>
											</div>
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Est. Delivery End</label>
												<input
													type="datetime-local"
													className="input"
													value={parcelForm.estimatedDeliveryEnd}
													onChange={(e) =>
														setParcelForm({
															...parcelForm,
															estimatedDeliveryEnd: e.target.value,
														})
													}
												/>
											</div>
										</div>
										<div className="form-row">
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Latitude</label>
												<input
													type="number"
													step="0.0001"
													className="input"
													value={parcelForm.lat}
													onChange={(e) =>
														setParcelForm({ ...parcelForm, lat: e.target.value })
													}
												/>
											</div>
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Longitude</label>
												<input
													type="number"
													step="0.0001"
													className="input"
													value={parcelForm.lng}
													onChange={(e) =>
														setParcelForm({ ...parcelForm, lng: e.target.value })
													}
												/>
											</div>
										</div>
									</div>
									<div className="modal-footer">
										<button
											type="button"
											className="btn"
											onClick={() => setShowEditModal(false)}
										>
											Cancel
										</button>
										<button type="submit" className="btn btn-primary">
											Save Changes
										</button>
									</div>
								</form>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
