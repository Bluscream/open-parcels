/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
/* biome-ignore-all lint/style/noNonNullAssertion: disable non-null assertion check */
/* biome-ignore-all lint/suspicious/noArrayIndexKey: disable array index key check */
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
	MapContainer,
	Marker,
	Polyline,
	Popup,
	TileLayer,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import markerIcon from "leaflet/dist/images/marker-icon.png";

// Leaflet icon fix
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import {
	ArrowLeft,
	Calendar,
	CheckCircle,
	MapPin,
	Package,
	RefreshCw,
	RotateCcw,
	Truck,
} from "lucide-react";
import { getGuestToken } from "../utils/auth";
import {
	generateCurvedPath,
	iconCurrent,
	iconHome,
	iconIntermediate,
	iconSource,
} from "../utils/mapIcons";
import { MapFitter } from "./MapFitter";

delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
	iconUrl: markerIcon,
	iconRetinaUrl: markerIcon2x,
	shadowUrl: markerShadow,
});

const STATUS_LABELS: Record<string, string> = {
	ordered: "Ordered",
	sent: "Dispatched",
	arriving: "Arriving",
	delivered: "Delivered",
	"return-accepted": "Return Accepted",
};

// Default recipient home location fallback
const DEFAULT_HOME = { lat: 50.1109, lng: 8.6821, name: "Home (Destination)" };

interface Parcel {
	id: number;
	trackingNumber: string;
	name?: string | null;
	courier: string;
	status: string;
	lat?: number;
	lng?: number;
	estimatedDeliveryStart?: string;
	estimatedDeliveryEnd?: string;
	createdAt: string;
	updatedAt: string;
}

interface ParcelEvent {
	id: number;
	location: string | null;
	description: string;
	timestamp: string;
	lat: number | null;
	lng: number | null;
	source?: string | null;
}

interface ParcelDetailProps {
	trackingNumber: string;
	onBack: () => void;
}

export const ParcelDetail: React.FC<ParcelDetailProps> = ({
	trackingNumber,
	onBack,
}) => {
	const [parcel, setParcel] = useState<Parcel | null>(null);
	const [events, setEvents] = useState<ParcelEvent[]>([]);
	const [loading, setLoading] = useState<boolean>(true);
	const [refreshing, setRefreshing] = useState<boolean>(false);
	const [error, setError] = useState<string | null>(null);
	const [isEditingName, setIsEditingName] = useState(false);
	const [editedName, setEditedName] = useState("");
	const [homeLocation, setHomeLocation] = useState<{
		lat: number;
		lng: number;
		name: string;
	} | null>(null);

	const fetchDetails = useCallback(async () => {
		try {
			// Shift execution to microtask to prevent synchronous state updates within effects
			await Promise.resolve();
			setLoading(true);
			setError(null);

			const parcelRes = await fetch(
				`/api/v1/parcels/${trackingNumber}?token=${getGuestToken()}`,
			);
			if (!parcelRes.ok) {
				throw new Error("Parcel not found");
			}
			const parcelData = await parcelRes.json();
			setParcel(parcelData);

			// Fetch events
			const eventsRes = await fetch(
				`/api/v1/parcels/${trackingNumber}/events?token=${getGuestToken()}`,
			);
			if (eventsRes.ok) {
				const eventsData = await eventsRes.json();
				// Sort events by timestamp asc first to identify consecutive duplicates
				const sortedEvents = Array.isArray(eventsData)
					? [...eventsData].sort(
							(a, b) =>
								new Date(a.timestamp).getTime() -
								new Date(b.timestamp).getTime(),
						)
					: [];

				const filteredEvents: ParcelEvent[] = [];
				for (const ev of sortedEvents) {
					if (filteredEvents.length === 0) {
						filteredEvents.push(ev);
						continue;
					}
					const prev = filteredEvents[filteredEvents.length - 1];
					const prevMin = new Date(prev.timestamp).toISOString().substring(0, 16);
					const currMin = new Date(ev.timestamp).toISOString().substring(0, 16);
					const sameTime = prevMin === currMin;
					const sameText = (prev.description || "").trim() === (ev.description || "").trim();

					if (sameTime || sameText) {
						continue;
					}
					filteredEvents.push(ev);
				}

				// Sort descending for timeline listing
				const finalEvents = filteredEvents.sort(
					(a, b) =>
						new Date(b.timestamp).getTime() -
						new Date(a.timestamp).getTime(),
				);
				setEvents(finalEvents);
			}

			// Fetch settings for home coordinates
			const settingsRes = await fetch(
				`/api/v1/settings?token=${getGuestToken()}`,
			);
			if (settingsRes.ok) {
				const settingsData = await settingsRes.json();
				setHomeLocation({
					lat: parseFloat(settingsData.home_latitude),
					lng: parseFloat(settingsData.home_longitude),
					name: settingsData.home_name,
				});
			}
		} catch (err) {
			console.error(err);
			setError(
				err instanceof Error ? err.message : "Failed to load parcel details",
			);
		} finally {
			setLoading(false);
		}
	}, [trackingNumber]);

	useEffect(() => {
		const timer = setTimeout(() => {
			fetchDetails();
		}, 0);
		return () => clearTimeout(timer);
	}, [fetchDetails]);

	useEffect(() => {
		const handleUpdate = (e: Event) => {
			const detail = (e as CustomEvent).detail;
			if (detail && detail.trackingNumber === trackingNumber) {
				console.log(
					"[ParcelDetail] Received update event for current parcel. Reloading details...",
				);
				fetchDetails();
			}
		};
		window.addEventListener("parcel-update", handleUpdate);
		return () => window.removeEventListener("parcel-update", handleUpdate);
	}, [trackingNumber, fetchDetails]);

	const handleRefresh = async () => {
		if (!parcel || refreshing) return;
		try {
			setRefreshing(true);
			if (parcel.id === 0) {
				// For non-db guest one-time lookups, we just query the endpoint again (which aggregates freshly)
				await fetchDetails();
			} else {
				// Trigger a live track update using the admin token
				const res = await fetch(
					`/api/v1/parcels/${parcel.id}/track?token=${getGuestToken()}`,
					{
						method: "POST",
					},
				);
				if (!res.ok) {
					throw new Error("Failed to refresh tracking information");
				}
				// Reload details after update
				await fetchDetails();
			}
		} catch (err) {
			alert(err instanceof Error ? err.message : "Error refreshing parcel");
		} finally {
			setRefreshing(false);
		}
	};

	const handleSaveName = async () => {
		if (!parcel) return;
		try {
			const res = await fetch(
				`/api/v1/parcels/${parcel.id}?token=${getGuestToken()}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ name: editedName || null }),
				},
			);
			if (res.ok) {
				const updated = await res.json();
				setParcel(updated);
				setIsEditingName(false);
			} else {
				alert("Failed to update nickname");
			}
		} catch (err) {
			console.error(err);
			alert("Error saving nickname");
		}
	};

	const getStatusIcon = (status: string, size = 16) => {
		switch (status) {
			case "ordered":
				return <Package size={size} className="text-blue-400" />;
			case "sent":
				return <Truck size={size} className="text-yellow-400" />;
			case "arriving":
				return <Truck size={size} className="text-orange-400" />;
			case "delivered":
				return <CheckCircle size={size} className="text-green-400" />;
			case "return-accepted":
				return <RotateCcw size={size} className="text-red-400" />;
			default:
				return <Package size={size} />;
		}
	};

	const formatDate = (dateStr: string) => {
		return new Date(dateStr).toLocaleString(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		});
	};

	if (loading) {
		return (
			<div
				className="dashboard-container"
				style={{ justifyContent: "center", alignItems: "center" }}
			>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						gap: "16px",
					}}
				>
					<RefreshCw className="animate-spin text-blue-500" size={32} />
					<span>Loading parcel details...</span>
				</div>
			</div>
		);
	}

	if (error || !parcel) {
		return (
			<div
				className="dashboard-container"
				style={{ justifyContent: "center", alignItems: "center" }}
			>
				<div
					className="glass-panel"
					style={{ padding: "32px", textAlign: "center", maxWidth: "400px" }}
				>
					<h2 style={{ marginTop: 0, color: "var(--text-main)" }}>Error</h2>
					<p style={{ color: "var(--text-muted)", marginBottom: "24px" }}>
						{error || "Parcel not found"}
					</p>
					<button
						onClick={onBack}
						className="btn btn-secondary"
						style={{
							display: "flex",
							alignItems: "center",
							gap: "8px",
							margin: "0 auto",
							background: "rgba(255,255,255,0.05)",
							border: "1px solid var(--panel-border)",
							color: "var(--text-main)",
							padding: "10px 20px",
							borderRadius: "8px",
							cursor: "pointer",
						}}
					>
						<ArrowLeft size={16} /> Back to Dashboard
					</button>
				</div>
			</div>
		);
	}

	const home = homeLocation || DEFAULT_HOME;

	// Calculate route points from events (oldest first for line direction)
	const routePoints = [...events]
		.filter((e) => e.lat !== null && e.lat !== undefined && e.lng !== null && e.lng !== undefined)
		.sort(
			(a, b) =>
				new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
		)
		.map((e) => ({
			lat: parseFloat(e.lat as any),
			lng: parseFloat(e.lng as any),
			description: e.description,
			timestamp: e.timestamp,
		}))
		.filter((e) => !Number.isNaN(e.lat) && !Number.isNaN(e.lng));

	const hasLocation =
		routePoints.length > 0 ||
		(parcel.lat !== null && parcel.lat !== undefined && parcel.lng !== null && parcel.lng !== undefined);
	const latestPoint =
		routePoints.length > 0
			? routePoints[routePoints.length - 1]
			: typeof parcel.lat === "number" && typeof parcel.lng === "number"
				? { lat: parseFloat(parcel.lat as any), lng: parseFloat(parcel.lng as any) }
				: null;
	const isDelivered = parcel.status === "delivered";

	return (
		<div
			className="dashboard-container"
			style={{
				display: "flex",
				flexDirection: "column",
				padding: "0 40px 40px 40px",
			}}
		>
			{/* Dynamic styles to enable premium animated flow lines */}
			<style>{`
        @keyframes flow-active {
          from {
            stroke-dashoffset: 24;
          }
          to {
            stroke-dashoffset: 0;
          }
        }
        .flow-line {
          stroke-dasharray: 8, 8;
          animation: flow-active 1.5s linear infinite;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        .flow-line-dest {
          stroke-dasharray: 6, 6;
          animation: flow-active 2.5s linear infinite;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
      `}</style>

			{/* Header / Nav */}
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
					className="hover-bright"
				>
					<ArrowLeft size={20} /> Back to Dashboard
				</button>

				<button
					onClick={handleRefresh}
					disabled={refreshing}
					style={{
						display: "flex",
						alignItems: "center",
						gap: "8px",
						background: refreshing
							? "rgba(59, 130, 246, 0.3)"
							: "var(--accent)",
						border: "none",
						color: "white",
						cursor: refreshing ? "not-allowed" : "pointer",
						fontSize: "14px",
						padding: "8px 16px",
						borderRadius: "8px",
						fontWeight: 500,
					}}
				>
					<RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
					{refreshing ? "Refreshing..." : "Refresh Tracking"}
				</button>
			</div>

			<div
				style={{
					display: "flex",
					gap: "24px",
					flex: 1,
					height: "calc(100% - 44px)",
					overflow: "hidden",
				}}
			>
				{/* Left Side: Parcel Details & History Timeline */}
				<div
					className="glass-panel"
					style={{
						flex: 1,
						padding: "24px",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: "16px",
							marginBottom: "20px",
						}}
					>
						<div
							style={{
								padding: "12px",
								borderRadius: "12px",
								background: "rgba(59, 130, 246, 0.1)",
							}}
						>
							{getStatusIcon(parcel.status, 24)}
						</div>
						<div>
							<div style={{ fontSize: "14px", color: "var(--text-muted)" }}>
								{parcel.courier}
							</div>
							{isEditingName ? (
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: "8px",
										marginTop: "4px",
									}}
								>
									<input
										type="text"
										value={editedName}
										onChange={(e) => setEditedName(e.target.value)}
										placeholder="Enter custom nickname..."
										className="input"
										style={{
											padding: "4px 8px",
											fontSize: "14px",
											borderRadius: "6px",
											width: "180px",
										}}
									/>
									<button
										onClick={handleSaveName}
										className="btn btn-primary btn-sm"
										style={{ padding: "4px 8px", fontSize: "12px" }}
									>
										Save
									</button>
									<button
										onClick={() => {
											setIsEditingName(false);
											setEditedName(parcel.name || "");
										}}
										className="btn btn-sm"
										style={{
											padding: "4px 8px",
											fontSize: "12px",
											background: "none",
										}}
									>
										Cancel
									</button>
								</div>
							) : (
								<div
									style={{ display: "flex", alignItems: "center", gap: "8px" }}
								>
									<h2
										style={{
											margin: 0,
											fontSize: "20px",
											fontWeight: 600,
											color: "var(--text-main)",
										}}
									>
										{parcel.name
											? `${parcel.name} (${parcel.trackingNumber})`
											: parcel.trackingNumber}
									</h2>
									{parcel.id !== 0 && (
										<button
											onClick={() => {
												setEditedName(parcel.name || "");
												setIsEditingName(true);
											}}
											style={{
												background: "none",
												border: "none",
												color: "var(--text-muted)",
												cursor: "pointer",
												padding: 0,
												display: "flex",
												alignItems: "center",
											}}
											className="hover-bright"
											title="Edit label"
										>
											<svg
												xmlns="http://www.w3.org/2000/svg"
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
												<path d="M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
											</svg>
										</button>
									)}
								</div>
							)}
						</div>
						<div
							style={{
								marginLeft: "auto",
								padding: "6px 12px",
								borderRadius: "8px",
								background: "rgba(255, 255, 255, 0.05)",
								border: "1px solid var(--panel-border)",
								textTransform: "uppercase",
								fontSize: "12px",
								fontWeight: 600,
								letterSpacing: "0.5px",
							}}
						>
							{STATUS_LABELS[parcel.status] || parcel.status}
						</div>
					</div>

					{/* Delivery Estimation Card */}
					<div
						style={{
							background: "rgba(255, 255, 255, 0.02)",
							border: "1px solid rgba(255,255,255,0.05)",
							borderRadius: "12px",
							padding: "16px",
							marginBottom: "24px",
							display: "flex",
							gap: "16px",
							alignItems: "center",
						}}
					>
						<Calendar size={20} className={isDelivered ? "text-green-400" : "text-blue-400"} />
						<div>
							<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
								{isDelivered ? "Delivery Date" : "Estimated Delivery"}
							</div>
							<div style={{ fontSize: "15px", fontWeight: 500 }}>
								{isDelivered ? (
									events.length > 0
										? formatDate(events[0].timestamp)
										: parcel.updatedAt
											? formatDate(parcel.updatedAt)
											: "Delivered"
								) : parcel.estimatedDeliveryStart ? (
									new Date(parcel.estimatedDeliveryStart).toLocaleDateString(
										undefined,
										{ dateStyle: "long" },
									)
								) : (
									"Pending Information"
								)}
							</div>
						</div>
					</div>

					<h3
						style={{ margin: "0 0 16px 0", fontSize: "16px", fontWeight: 600 }}
					>
						Tracking History
					</h3>

					{/* Events Scroll Container */}
					<div className="parcel-list" style={{ flex: 1 }}>
						{events.length === 0 ? (
							<div
								style={{
									textAlign: "center",
									padding: "40px 20px",
									color: "var(--text-muted)",
								}}
							>
								<Package
									size={32}
									style={{ marginBottom: "12px", opacity: 0.5 }}
								/>
								<div>No tracking status updates available yet.</div>
							</div>
						) : (
							<div
								style={{
									display: "flex",
									flexDirection: "column",
									gap: "20px",
									position: "relative",
									paddingLeft: "20px",
									borderLeft: "2px solid rgba(255,255,255,0.08)",
									marginLeft: "10px",
								}}
							>
								{events.map((event, idx) => (
									<div key={event.id} style={{ position: "relative" }}>
										{/* Circle dot on timeline */}
										<div
											style={{
												position: "absolute",
												left: "-27px",
												top: "4px",
												width: "12px",
												height: "12px",
												borderRadius: "50%",
												background:
													idx === 0
														? "var(--accent)"
														: "rgba(255, 255, 255, 0.2)",
												border: "2px solid var(--bg-dark)",
											}}
										/>

										<div
											style={{
												display: "flex",
												justifyContent: "space-between",
												alignItems: "flex-start",
											}}
										>
											<div
												style={{
													fontWeight: 500,
													fontSize: "14px",
													color:
														idx === 0
															? "var(--text-main)"
															: "rgba(248, 250, 252, 0.8)",
												}}
											>
												<span>{event.description}</span>
												{event.source && (
													<span
														style={{
															fontSize: "10px",
															color: "var(--text-muted)",
															background: "rgba(255, 255, 255, 0.05)",
															padding: "2px 6px",
															borderRadius: "4px",
															marginLeft: "8px",
															border: "1px solid rgba(255,255,255,0.05)",
															display: "inline-block",
															verticalAlign: "middle",
															fontWeight: 400,
														}}
													>
														{event.source}
													</span>
												)}
											</div>
											<div
												style={{
													fontSize: "11px",
													color: "var(--text-muted)",
													whiteSpace: "nowrap",
													marginLeft: "12px",
												}}
											>
												{formatDate(event.timestamp)}
											</div>
										</div>
										{event.location && (
											<div
												style={{
													fontSize: "12px",
													color: "var(--accent)",
													display: "flex",
													alignItems: "center",
													gap: "4px",
													marginTop: "4px",
												}}
											>
												<MapPin size={12} />
												<span>{event.location}</span>
											</div>
										)}
									</div>
								))}
							</div>
						)}
					</div>
				</div>

				{/* Right Side: Map */}
				<div
					className="glass-panel"
					style={{
						flex: 1.5,
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					{hasLocation ? (
						<div style={{ width: "100%", height: "100%" }}>
							<MapContainer
								center={
									latestPoint ? [latestPoint.lat, latestPoint.lng] : [0, 0]
								}
								zoom={7}
								scrollWheelZoom={true}
								style={{ height: "100%", width: "100%" }}
							>
								<MapFitter
									bounds={
										routePoints.length > 0 || (latestPoint && !isDelivered)
											? [
													...routePoints.map((p) => [p.lat, p.lng] as [number, number]),
													...(latestPoint && !isDelivered ? [[home.lat, home.lng] as [number, number]] : []),
												]
											: undefined
									}
								/>
								<TileLayer
									attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
									url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
								/>

								{/* Draw Route Polyline connecting geocoded timeline events (Active Flow) */}
								{routePoints.length > 1 && (
									<Polyline
										positions={generateCurvedPath(
											routePoints.map((p) => [p.lat, p.lng]) as [number, number][]
										)}
										pathOptions={{
											color: "#3b82f6",
											weight: 4,
											opacity: 0.9,
											className: "flow-line",
										}}
									/>
								)}

								{/* Draw Polyline to Home Destination if not delivered (Future Flow - More Transparent) */}
								{latestPoint && !isDelivered && (
									<Polyline
										positions={generateCurvedPath([
											[latestPoint.lat, latestPoint.lng],
											[home.lat, home.lng],
										])}
										pathOptions={{
											color: "#a78bfa",
											weight: 3,
											opacity: 0.4,
											className: "moving-dash",
										}}
									/>
								)}

								{/* Markers for all intermediate points on the route */}
								{routePoints.map((point, idx) => {
									const isSource = idx === 0;
									const isCurrent = idx === routePoints.length - 1;
									const markerIcon = isSource
										? iconSource
										: isCurrent
											? iconCurrent
											: iconIntermediate;

									return (
										<Marker key={idx} position={[point.lat, point.lng]} icon={markerIcon}>
											<Popup className="custom-popup">
												<div className="popup-content">
													<strong className="tracking-number">
														{isSource
															? "🟢 Source Depot"
															: isCurrent
																? "📍 Current Location"
																: "📦 Intermediate Stop"}
													</strong>
													<div style={{ fontSize: "13px", margin: "4px 0" }}>
														{point.description}
													</div>
													<div
														style={{
															fontSize: "11px",
															color: "var(--text-muted)",
														}}
													>
														{formatDate(point.timestamp)}
													</div>
												</div>
											</Popup>
										</Marker>
									);
								})}

								{/* Marker for Destination Home */}
								{!isDelivered && (
									<Marker position={[home.lat, home.lng]} icon={iconHome}>
										<Popup className="custom-popup">
											<div className="popup-content">
												<strong className="tracking-number">
													🏠 Destination ({home.name})
												</strong>
												<div
													style={{
														fontSize: "12px",
														color: "var(--text-muted)",
														marginTop: "4px",
													}}
												>
													Shipment is heading here.
												</div>
											</div>
										</Popup>
									</Marker>
								)}
							</MapContainer>
						</div>
					) : (
						<div
							style={{
								flex: 1,
								display: "flex",
								flexDirection: "column",
								alignItems: "center",
								justifyContent: "center",
								padding: "40px",
								textAlign: "center",
								background: "rgba(0,0,0,0.1)",
							}}
						>
							<MapPin
								size={48}
								style={{
									color: "var(--text-muted)",
									opacity: 0.3,
									marginBottom: "16px",
								}}
							/>
							<h3
								style={{
									margin: "0 0 8px 0",
									fontSize: "16px",
									fontWeight: 600,
								}}
							>
								Location Map Not Available
							</h3>
							<p
								style={{
									margin: 0,
									fontSize: "14px",
									color: "var(--text-muted)",
									maxWidth: "300px",
								}}
							>
								This parcel does not have precise geographic coordinates.
								Location updates will still appear in the status history on the
								left.
							</p>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
