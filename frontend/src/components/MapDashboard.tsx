/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
/* biome-ignore-all lint/style/noNonNullAssertion: leaflet marker coordinates */
import type React from "react";
import { useEffect, useState } from "react";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet icon fix
import L from "leaflet";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { CheckCircle, Package, RotateCcw, Truck } from "lucide-react";
import { getGuestToken } from "../utils/auth";

delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
	iconUrl: markerIcon,
	iconRetinaUrl: markerIcon2x,
	shadowUrl: markerShadow,
});

interface Parcel {
	id: number;
	trackingNumber: string;
	name?: string;
	courier: string;
	status: string;
	lat?: number;
	lng?: number;
	estimatedDelivery?: string;
}

interface MapDashboardProps {
	onSelectParcel?: (trackingNumber: string) => void;
}

export const MapDashboard: React.FC<MapDashboardProps> = ({
	onSelectParcel,
}) => {
	const [parcels, setParcels] = useState<Parcel[]>([]);

	useEffect(() => {
		fetch(`/api/v1/parcels?token=${getGuestToken()}`)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP error! Status: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (Array.isArray(data)) {
					// Map backend fields to frontend interface if necessary
					setParcels(
						data.map((p) => ({
							id: p.id,
							trackingNumber: p.trackingNumber,
							name: p.name || undefined,
							courier: p.courier || "Unknown",
							status: p.status,
							lat: p.lat || undefined,
							lng: p.lng || undefined,
							estimatedDelivery: p.estimatedDeliveryStart
								? new Date(p.estimatedDeliveryStart).toLocaleDateString()
								: "Pending",
						})),
					);
				}
			})
			.catch((err) => {
				console.error("Failed to fetch parcels:", err);
				setParcels([]);
			});
	}, []);

	const getStatusIcon = (status: string) => {
		switch (status) {
			case "ordered":
				return <Package size={16} className="text-blue-400" />;
			case "sent":
				return <Truck size={16} className="text-yellow-400" />;
			case "arriving":
				return <Truck size={16} className="text-orange-400" />;
			case "delivered":
				return <CheckCircle size={16} className="text-green-400" />;
			case "return-accepted":
				return <RotateCcw size={16} className="text-red-400" />;
			default:
				return <Package size={16} />;
		}
	};

	const activeParcels = parcels.filter(
		(p) =>
			p.status !== "delivered" &&
			p.status !== "return" &&
			p.status !== "return-accepted",
	);

	return (
		<div className="dashboard-container">
			<div className="glass-panel map-panel">
				<h2 className="panel-title">Live Tracking</h2>
				<div className="map-wrapper">
					<MapContainer
						center={[45.0, 0.0]}
						zoom={3}
						scrollWheelZoom={true}
						style={{ height: "100%", width: "100%", borderRadius: "12px" }}
					>
						<TileLayer
							attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
							url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
						/>
						{activeParcels
							.filter((p) => p.lat && p.lng)
							.map((parcel) => (
								<Marker key={parcel.id} position={[parcel.lat!, parcel.lng!]}>
									<Popup className="custom-popup">
										<div className="popup-content">
											<strong
												className="tracking-number"
												style={{ cursor: "pointer" }}
												onClick={() => onSelectParcel?.(parcel.trackingNumber)}
											>
												{parcel.name
													? `${parcel.name} (${parcel.trackingNumber})`
													: parcel.trackingNumber}
											</strong>
											<div className="courier-info">{parcel.courier}</div>
											<div className="status-info">
												{getStatusIcon(parcel.status)}
												<span>{parcel.status.toUpperCase()}</span>
											</div>
										</div>
									</Popup>
								</Marker>
							))}
					</MapContainer>
				</div>
			</div>

			<div className="glass-panel list-panel">
				<h2 className="panel-title">Parcels in Transit</h2>
				<div className="parcel-list">
					{activeParcels.length === 0 ? (
						<div className="empty-list-message" style={{ color: "var(--text-muted)", padding: "40px 20px", textAlign: "center", fontStyle: "italic" }}>
							No active parcels in transit
						</div>
					) : (
						activeParcels.map((parcel) => (
							<div
								key={parcel.id}
								className="parcel-card"
								onClick={() => onSelectParcel?.(parcel.trackingNumber)}
							>
								<div className="parcel-icon">{getStatusIcon(parcel.status)}</div>
								<div className="parcel-details">
									<div className="parcel-id">
										{parcel.name
											? `${parcel.name} (${parcel.trackingNumber})`
											: parcel.trackingNumber}
									</div>
									<div className="parcel-meta">
										{parcel.courier} &bull; {parcel.estimatedDelivery}
									</div>
								</div>
								<div className="parcel-status-badge">{parcel.status}</div>
							</div>
						))
					)}
				</div>
			</div>
		</div>
	);
};
