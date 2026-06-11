/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
/* biome-ignore-all lint/style/noNonNullAssertion: leaflet marker coordinates */
import type React from "react";
import { useEffect, useState } from "react";
import { Marker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";

// Leaflet icon fix
import L from "leaflet";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { CheckCircle, Package, RotateCcw, Truck } from "lucide-react";
import { getGuestToken } from "../utils/auth";
import { formatRelativeEta } from "../utils/dateUtils";
import { generateCurvedPath, getTransportMarkerIcon, iconHome, determineTransportMethod } from "../utils/mapIcons";
import { AnimatedRoute } from "./AnimatedRoute";
import { CourierLogo } from "./CourierLogo";
import { SharedMap, useMapFilters } from "./SharedMap";
import { SplitContainer } from "./SplitContainer";

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
	transportMethod?: string;
	lastEventDescription?: string;
	events?: any[];
}

interface MapDashboardProps {
	onSelectParcel?: (trackingNumber: string) => void;
}


const DashboardMapContent: React.FC<{
	homeCoords: { lat: number; lng: number } | null;
	activeParcels: Parcel[];
	onSelectParcel?: (trackingNumber: string) => void;
	getStatusIcon: (status: string) => React.ReactNode;
}> = ({ homeCoords, activeParcels, onSelectParcel, getStatusIcon }) => {
	const { filters } = useMapFilters();

	return (
		<>
			{homeCoords && filters.home && (
				<Marker position={[homeCoords.lat, homeCoords.lng]} icon={iconHome} zIndexOffset={-100}>
					<Popup className="custom-popup">
						<div className="popup-content">
							<strong style={{ color: "#10b981" }}>Home</strong>
							<div className="status-info">Destination</div>
						</div>
					</Popup>
				</Marker>
			)}
			{activeParcels
				.filter((p) => p.lat && p.lng)
				.map((parcel) => (
					<div key={parcel.id}>
						{homeCoords && filters.futurePath && (
							<AnimatedRoute
								positions={generateCurvedPath([
									[parcel.lat!, parcel.lng!],
									[homeCoords.lat, homeCoords.lng],
								]) as [number, number][]}
								color="#a78bfa"
							/>
						)}
						{filters.parcel && (
							<Marker position={[parcel.lat!, parcel.lng!]} icon={getTransportMarkerIcon(parcel.transportMethod)} zIndexOffset={1000}>
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
											<span>{parcel.lastEventDescription || parcel.status.toUpperCase()}</span>
										</div>
									</div>
								</Popup>
							</Marker>
						)}
					</div>
				))}
		</>
	);
};

export const MapDashboard: React.FC<MapDashboardProps> = ({
	onSelectParcel,
}) => {
	const [parcels, setParcels] = useState<Parcel[]>([]);
	const [homeCoords, setHomeCoords] = useState<{ lat: number; lng: number } | null>(null);

	useEffect(() => {
		fetch(`/api/v1/parcels?token=${getGuestToken()}`)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP error! Status: ${res.status}`);
				return res.json();
			})
			.then((data) => {
				if (Array.isArray(data)) {
					setParcels(
						data.map((p: any) => ({
							...p,
							lat: p.lat ? parseFloat(p.lat) : undefined,
							lng: p.lng ? parseFloat(p.lng) : undefined,
							estimatedDelivery: p.estimatedDeliveryStart
								? new Date(p.estimatedDeliveryStart).toLocaleDateString()
								: undefined,
							events: p.events,
							transportMethod: p.lastVehicle || determineTransportMethod(p.events || []),
							lastEventDescription: p.lastEventDescription || undefined,
						})),
					);
				}
			})
			.catch((err) => {
				console.error("Failed to fetch parcels:", err);
				setParcels([]);
			});

		// Fetch home settings
		fetch(`/api/v1/settings?token=${getGuestToken()}`)
			.then((res) => res.json())
			.then((data) => {
				if (data.home_latitude !== undefined && data.home_longitude !== undefined) {
					setHomeCoords({
						lat: parseFloat(data.home_latitude),
						lng: parseFloat(data.home_longitude),
					});
				}
			})
			.catch((err) => console.error("Failed to fetch home settings", err));
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
			<SplitContainer
				leftDefaultSize={70}
				leftMinSize={40}
				rightDefaultSize={30}
				rightMinSize={20}
				leftPanel={
					<div className="glass-panel" style={{ height: "100%", overflow: "hidden", position: "relative" }}>
						<SharedMap
							center={[45.0, 0.0]}
							zoom={3}
							bounds={
								activeParcels.filter((p) => p.lat && p.lng).length > 0 || homeCoords
									? [
											...activeParcels
												.filter((p) => p.lat && p.lng)
												.map((p) => [p.lat!, p.lng!] as [number, number]),
											...(homeCoords ? [[homeCoords.lat, homeCoords.lng] as [number, number]] : []),
										]
									: undefined
							}
						>
							<DashboardMapContent
								homeCoords={homeCoords}
								activeParcels={activeParcels}
								onSelectParcel={onSelectParcel}
								getStatusIcon={getStatusIcon}
							/>
						</SharedMap>
					</div>
				}
				rightPanel={
			<div className="glass-panel list-panel" style={{ height: "100%" }}>
				<h2 className="panel-title">Parcels in Transit</h2>
				<div className="parcel-list">
					{activeParcels.length === 0 ? (
						<div className="empty-list-message" style={{ color: "var(--text-muted)", padding: "40px 20px", textAlign: "center", fontStyle: "italic" }}>
							No active parcels in transit
						</div>
					) : (
						activeParcels.map((parcel) => {
						const eta = formatRelativeEta(parcel.estimatedDelivery);

						return (
							<div
								key={parcel.id}
								className="parcel-card"
								onClick={() => onSelectParcel?.(parcel.trackingNumber)}
							>
								<div className="parcel-icon">
									<CourierLogo courier={parcel.courier} size={28} />
								</div>
								<div className="parcel-details">
									<div className="parcel-id">
										{parcel.name
											? `${parcel.name} (${parcel.trackingNumber})`
											: parcel.trackingNumber}
									</div>
									<div className="parcel-meta">
										{parcel.lastEventDescription
											? parcel.lastEventDescription
											: `${parcel.courier} • ${parcel.status}`}
									</div>
									{eta && (
										<div className="parcel-eta" style={{ fontSize: "0.7rem", opacity: 0.6, marginTop: 1 }}>
											{eta}
										</div>
									)}
								</div>
								<div className="parcel-status-badge">{parcel.status}</div>
							</div>
						);
					})
				)}
				</div>
			</div>
				}
			/>
		</div>
	);
};
;
