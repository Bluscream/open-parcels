/* biome-ignore-all lint/suspicious/noExplicitAny: dynamic API data */
import { RefreshCw, Package, MapPin, Truck, Calendar, Hash } from "lucide-react";
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
	sent: "Sent",
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
			setParcels(await res.json());
		} catch (e: any) {
			setError(e.message ?? "Failed to load parcels");
		} finally {
			setLoading(false);
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
								<th>Updated</th>
							</tr>
						</thead>
						<tbody>
							{loading && (
								<tr>
									<td colSpan={8} className="table-placeholder">
										<RefreshCw size={18} className="spin" /> Loading…
									</td>
								</tr>
							)}
							{!loading && parcels.length === 0 && (
								<tr>
									<td colSpan={8} className="table-placeholder">No parcels found.</td>
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
									<td className="text-muted">{fmtDate(p.updatedAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
