/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
import {
	ArrowLeft,
	Calendar,
	CheckCircle,
	ExternalLink,
	Package,
	RefreshCw,
	RotateCcw,
	ShoppingBag,
	Truck,
} from "lucide-react";
import type React from "react";
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

interface Parcel {
	id: number;
	trackingNumber: string;
	name?: string;
	courier?: string;
	status: string;
	estimatedDeliveryStart?: string;
	updatedAt: string;
}

interface OrderDetailProps {
	orderId: string;
	onBack: () => void;
	onSelectParcel: (trackingNumber: string) => void;
}

function fmtDate(iso?: string) {
	if (!iso) return "—";
	return new Date(iso).toLocaleString(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

function StatusTag({ status }: { status: string }) {
	const s = status.toLowerCase();
	let cls = "";
	if (s === "delivered" || s.includes("deliver") || s.includes("complet")) cls = "status-delivered";
	else if (s === "arriving") cls = "status-arriving";
	else if (s === "sent" || s.includes("ship")) cls = "status-sent";
	else if (s === "return" || s.includes("return")) cls = "status-return-sent";
	else cls = "status-ordered";
	return <span className={`status-tag ${cls}`}>{status}</span>;
}

function ParcelStatusIcon({ status, size = 16 }: { status: string; size?: number }) {
	switch (status) {
		case "ordered": return <Package size={size} className="text-blue-400" />;
		case "sent": return <Truck size={size} className="text-yellow-400" />;
		case "arriving": return <Truck size={size} className="text-orange-400" />;
		case "delivered": return <CheckCircle size={size} className="text-green-400" />;
		case "return":
		case "return-accepted": return <RotateCcw size={size} className="text-red-400" />;
		default: return <Package size={size} />;
	}
}

export const OrderDetail: React.FC<OrderDetailProps> = ({ orderId, onBack, onSelectParcel }) => {
	const [order, setOrder] = useState<Order | null>(null);
	const [linkedParcels, setLinkedParcels] = useState<Parcel[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [linkInput, setLinkInput] = useState("");
	const [linking, setLinking] = useState(false);
	const [linkError, setLinkError] = useState("");

	const token = getGuestToken();

	const load = async () => {
		setLoading(true);
		setError(null);
		try {
			const [orderRes, parcelsRes] = await Promise.all([
				fetch(`/api/v1/orders/${orderId}?token=${token}`),
				fetch(`/api/v1/orders/${orderId}/parcels?token=${token}`),
			]);

			if (!orderRes.ok) throw new Error("Order not found");
			const orderData = await orderRes.json();
			setOrder(orderData);

			if (parcelsRes.ok) {
				const parcelsData = await parcelsRes.json();
				setLinkedParcels(Array.isArray(parcelsData) ? parcelsData : []);
			}
		} catch (e: any) {
			setError(e.message ?? "Failed to load order");
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		load();
	}, [orderId]);

	const handleLinkParcel = async (e: React.FormEvent) => {
		e.preventDefault();
		const tracking = linkInput.trim();
		if (!tracking) return;

		setLinking(true);
		setLinkError("");
		try {
			const res = await fetch(`/api/v1/orders/${orderId}/parcels?token=${token}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ trackingNumber: tracking }),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.error || `HTTP ${res.status}`);
			}
			setLinkInput("");
			await load();
		} catch (err: any) {
			setLinkError(err.message ?? "Failed to link parcel");
		} finally {
			setLinking(false);
		}
	};

	if (loading) {
		return (
			<div className="dashboard-container" style={{ justifyContent: "center", alignItems: "center" }}>
				<div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
					<RefreshCw className="animate-spin text-blue-500" size={32} />
					<span>Loading order details...</span>
				</div>
			</div>
		);
	}

	if (error || !order) {
		return (
			<div className="dashboard-container" style={{ justifyContent: "center", alignItems: "center" }}>
				<div className="glass-panel" style={{ padding: "32px", textAlign: "center", maxWidth: "400px" }}>
					<h2 style={{ marginTop: 0 }}>Error</h2>
					<p style={{ color: "var(--text-muted)", marginBottom: "24px" }}>{error || "Order not found"}</p>
					<button
						type="button"
						onClick={onBack}
						className="btn"
						style={{ display: "flex", alignItems: "center", gap: "8px", margin: "0 auto" }}
					>
						<ArrowLeft size={16} /> Back
					</button>
				</div>
			</div>
		);
	}

	const deliveredCount = linkedParcels.filter((p) => p.status === "delivered").length;
	const inTransitCount = linkedParcels.filter((p) => p.status === "sent" || p.status === "arriving").length;

	return (
		<div
			className="dashboard-container"
			style={{ display: "flex", flexDirection: "column", padding: "0 40px 40px 40px" }}
		>
			{/* Header row */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					marginBottom: "20px",
					width: "100%",
				}}
			>
				<button
					type="button"
					onClick={onBack}
					style={{
						display: "flex",
						alignItems: "center",
						gap: "8px",
						background: "none",
						border: "none",
						color: "var(--text-muted)",
						cursor: "pointer",
						fontSize: "16px",
						padding: 0,
					}}
				>
					<ArrowLeft size={20} /> Back to Orders
				</button>
			</div>

			<div style={{ display: "flex", gap: "24px", flex: 1, overflow: "hidden" }}>
				{/* Left: Order info */}
				<div
					className="glass-panel"
					style={{ width: "340px", flexShrink: 0, padding: "24px", display: "flex", flexDirection: "column", gap: "20px", overflowY: "auto" }}
				>
					{/* Title */}
					<div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
						<div style={{ padding: "10px", borderRadius: "12px", background: "rgba(59,130,246,0.1)" }}>
							<ShoppingBag size={22} className="text-blue-400" />
						</div>
						<div>
							<div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "2px" }}>
								{order.source}
							</div>
							<div style={{ fontSize: "18px", fontWeight: 700, fontFamily: "monospace", letterSpacing: "0.5px" }}>
								{order.orderNumber}
							</div>
						</div>
					</div>

					{/* Status */}
					<div
						style={{
							background: "rgba(255,255,255,0.02)",
							border: "1px solid rgba(255,255,255,0.05)",
							borderRadius: "12px",
							padding: "14px 16px",
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
						}}
					>
						<span style={{ fontSize: "13px", color: "var(--text-muted)" }}>Status</span>
						<StatusTag status={order.status} />
					</div>

					{/* Stats */}
					<div style={{ display: "flex", gap: "12px" }}>
						<div
							style={{
								flex: 1,
								background: "rgba(59,130,246,0.06)",
								border: "1px solid rgba(59,130,246,0.15)",
								borderRadius: "10px",
								padding: "12px",
								textAlign: "center",
							}}
						>
							<div style={{ fontSize: "22px", fontWeight: 700, color: "var(--accent)" }}>
								{linkedParcels.length}
							</div>
							<div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>Parcels</div>
						</div>
						<div
							style={{
								flex: 1,
								background: "rgba(34,197,94,0.06)",
								border: "1px solid rgba(34,197,94,0.15)",
								borderRadius: "10px",
								padding: "12px",
								textAlign: "center",
							}}
						>
							<div style={{ fontSize: "22px", fontWeight: 700, color: "#4ade80" }}>{deliveredCount}</div>
							<div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>Delivered</div>
						</div>
						<div
							style={{
								flex: 1,
								background: "rgba(249,115,22,0.06)",
								border: "1px solid rgba(249,115,22,0.15)",
								borderRadius: "10px",
								padding: "12px",
								textAlign: "center",
							}}
						>
							<div style={{ fontSize: "22px", fontWeight: 700, color: "#fb923c" }}>{inTransitCount}</div>
							<div style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "2px" }}>In Transit</div>
						</div>
					</div>

					{/* Timestamps */}
					<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
						<div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
							<Calendar size={14} className="text-blue-400" />
							<span style={{ color: "var(--text-muted)" }}>Created</span>
							<span style={{ marginLeft: "auto" }}>{fmtDate(order.createdAt)}</span>
						</div>
						<div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" }}>
							<RefreshCw size={14} className="text-blue-400" />
							<span style={{ color: "var(--text-muted)" }}>Updated</span>
							<span style={{ marginLeft: "auto" }}>{fmtDate(order.updatedAt)}</span>
						</div>
					</div>

					{/* Link parcel form */}
					<div style={{ borderTop: "1px solid var(--panel-border)", paddingTop: "16px" }}>
						<div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px", color: "var(--text-muted)" }}>
							Link a Parcel
						</div>
						<form onSubmit={handleLinkParcel} style={{ display: "flex", gap: "8px" }}>
							<input
								type="text"
								className="input"
								placeholder="Tracking number…"
								value={linkInput}
								onChange={(e) => setLinkInput(e.target.value)}
								style={{ flex: 1, padding: "8px 12px", fontSize: "13px" }}
							/>
							<button type="submit" className="btn btn-primary btn-sm" disabled={linking}>
								{linking ? <RefreshCw size={14} className="animate-spin" /> : "Link"}
							</button>
						</form>
						{linkError && (
							<div style={{ color: "#f87171", fontSize: "12px", marginTop: "6px" }}>{linkError}</div>
						)}
					</div>
				</div>

				{/* Right: Parcels list */}
				<div className="glass-panel" style={{ flex: 1, padding: "24px", display: "flex", flexDirection: "column", overflow: "hidden" }}>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							marginBottom: "20px",
						}}
					>
						<h3 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
							Parcels
							<span
								style={{
									marginLeft: "10px",
									fontSize: "13px",
									background: "rgba(59,130,246,0.15)",
									color: "var(--accent)",
									borderRadius: "20px",
									padding: "2px 10px",
									fontWeight: 500,
								}}
							>
								{linkedParcels.length}
							</span>
						</h3>
						<button type="button" className="btn btn-sm" onClick={load}>
							<RefreshCw size={13} /> Refresh
						</button>
					</div>

					<div style={{ flex: 1, overflowY: "auto" }}>
						{linkedParcels.length === 0 ? (
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									alignItems: "center",
									justifyContent: "center",
									height: "200px",
									color: "var(--text-muted)",
									gap: "12px",
								}}
							>
								<Package size={36} style={{ opacity: 0.4 }} />
								<div style={{ fontStyle: "italic", fontSize: "14px" }}>
									No parcels linked to this order yet.
								</div>
								<div style={{ fontSize: "12px", color: "var(--text-muted)", opacity: 0.7 }}>
									Use the "Link a Parcel" form on the left to add tracking numbers.
								</div>
							</div>
						) : (
							<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
								{linkedParcels.map((parcel) => (
									<div
										key={parcel.id}
										className="parcel-card"
										onClick={() => onSelectParcel(parcel.trackingNumber)}
										style={{ cursor: "pointer" }}
									>
										<div className="parcel-icon">
											<ParcelStatusIcon status={parcel.status} size={18} />
										</div>
										<div className="parcel-details">
											<div className="parcel-id">
												{parcel.name
													? `${parcel.name} (${parcel.trackingNumber})`
													: parcel.trackingNumber}
											</div>
											<div className="parcel-meta">
												{parcel.courier || "Unknown courier"}
												{parcel.estimatedDeliveryStart && (
													<>
														{" · "}
														<Calendar size={11} style={{ display: "inline", verticalAlign: "middle" }} />
														{" "}
														{new Date(parcel.estimatedDeliveryStart).toLocaleDateString()}
													</>
												)}
											</div>
										</div>
										<div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
											<StatusTag status={parcel.status} />
											<ExternalLink size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};
