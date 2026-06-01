/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
/* biome-ignore-all lint/correctness/noInvalidUseBeforeDeclaration: disable use before declaration check */
/* biome-ignore-all lint/correctness/useExhaustiveDependencies: disable exhaustive dependencies check */
import L from "leaflet";
import {
	ArrowLeft,
	Calendar,
	Clipboard,
	Edit2,
	Key,
	MapPin,
	Package,
	Plus,
	Settings,
	ShieldAlert,
	Trash2,
	X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import {
	MapContainer,
	Marker,
	TileLayer,
	useMap,
	useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";

import markerIcon from "leaflet/dist/images/marker-icon.png";
// Leaflet icon fix
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
	iconUrl: markerIcon,
	iconRetinaUrl: markerIcon2x,
	shadowUrl: markerShadow,
});

interface Parcel {
	id: number;
	trackingNumber: string;
	courier: string | null;
	status: string;
	lat: number | null;
	lng: number | null;
	estimatedDeliveryStart: string | null;
	estimatedDeliveryEnd: string | null;
}

interface Order {
	id: number;
	source: string;
	orderNumber: string;
	status: string;
	createdAt: string;
}

interface ParcelEvent {
	id: number;
	parcelId: number;
	location: string | null;
	description: string;
	timestamp: string;
}

interface CredentialService {
	id: number;
	service: string;
	updatedAt: string;
}

// Helper component to update leaflet map view center dynamically
const MapUpdater = ({ lat, lng }: { lat: number; lng: number }) => {
	const map = useMap();
	useEffect(() => {
		if (lat && lng && !Number.isNaN(lat) && !Number.isNaN(lng)) {
			map.setView([lat, lng], map.getZoom());
		}
	}, [lat, lng, map]);
	return null;
};

// Helper component to handle Leaflet map click actions
const MapClickHandler = ({
	onClick,
}: {
	onClick: (lat: number, lng: number) => void;
}) => {
	useMapEvents({
		click(e) {
			onClick(e.latlng.lat, e.latlng.lng);
		},
	});
	return null;
};

export const ManageInterface: React.FC = () => {
	const [token, setToken] = useState<string>(() => {
		const urlParams = new URLSearchParams(window.location.search);
		const urlToken = urlParams.get("token");
		const storedToken = localStorage.getItem("openparcels_admin_token");
		if (urlToken) {
			localStorage.setItem("openparcels_admin_token", urlToken);
			// Clean URL parameter
			window.history.replaceState({}, document.title, window.location.pathname);
			return urlToken;
		}
		return storedToken || "";
	});
	const [showTokenPrompt, setShowTokenPrompt] = useState<boolean>(() => {
		const urlParams = new URLSearchParams(window.location.search);
		const urlToken = urlParams.get("token");
		const storedToken = localStorage.getItem("openparcels_admin_token");
		return !urlToken && !storedToken;
	});
	const [tokenInput, setTokenInput] = useState<string>("");
	const [activeTab, setActiveTab] = useState<
		"parcels" | "orders" | "credentials" | "settings"
	>("parcels");

	// Settings state
	const [settingsForm, setSettingsForm] = useState({
		timezone: "",
		home_name: "",
		home_latitude: "",
		home_longitude: "",
	});

	const [searchQuery, setSearchQuery] = useState("");
	const [searchingLocation, setSearchingLocation] = useState(false);

	// Data states
	const [parcels, setParcels] = useState<Parcel[]>([]);
	const [orders, setOrders] = useState<Order[]>([]);
	const [credentialsList, setCredentialsList] = useState<CredentialService[]>(
		[],
	);
	const [selectedParcelEvents, setSelectedParcelEvents] = useState<
		ParcelEvent[]
	>([]);
	const [eventParcelId, setEventParcelId] = useState<number | null>(null);

	// Modals
	const [showParcelModal, setShowParcelModal] = useState<boolean>(false);
	const [showOrderModal, setShowOrderModal] = useState<boolean>(false);
	const [showEventModal, setShowEventModal] = useState<boolean>(false);
	const [showCredModal, setShowCredModal] = useState<boolean>(false);

	// Form states
	const [editingParcelId, setEditingParcelId] = useState<number | null>(null);
	const [parcelForm, setParcelForm] = useState({
		trackingNumber: "",
		courier: "",
		status: "ordered",
		lat: "",
		lng: "",
	});

	const [orderForm, setOrderForm] = useState({
		source: "Amazon",
		orderNumber: "",
		status: "processing",
	});

	const [eventForm, setEventForm] = useState({
		location: "",
		description: "",
		timestamp: new Date().toISOString().substring(0, 16),
	});

	const [credForm, setCredForm] = useState({
		service: "IMAP",
		username: "",
		password: "",
		host: "",
		port: "",
		tls: "true",
	});

	const fetchData = useCallback(async () => {
		try {
			// Fetch parcels
			const resP = await fetch(
				`/api/v1/parcels?token=${token}`,
			);
			if (resP.status === 403 || resP.status === 401) {
				localStorage.removeItem("openparcels_admin_token");
				setShowTokenPrompt(true);
				return;
			}
			const dataP = await resP.json();
			setParcels(dataP);

			// Fetch orders
			const resO = await fetch(
				`/api/v1/orders?token=${token}`,
			);
			const dataO = await resO.json();
			setOrders(dataO);

			// Fetch credentials
			const resC = await fetch(
				`/api/v1/credentials?token=${token}`,
			);
			if (resC.ok) {
				const dataC = await resC.json();
				setCredentialsList(dataC);
			}

			// Fetch settings
			const resS = await fetch(
				`/api/v1/settings?token=${token}`,
			);
			if (resS.ok) {
				const dataS = await resS.json();
				setSettingsForm({
					timezone: dataS.timezone || "",
					home_name: dataS.home_name || "",
					home_latitude:
						dataS.home_latitude !== undefined
							? dataS.home_latitude.toString()
							: "",
					home_longitude:
						dataS.home_longitude !== undefined
							? dataS.home_longitude.toString()
							: "",
				});
			}
		} catch (err) {
			console.error("Failed to fetch data", err);
		}
	}, [token]);

	// Fetch data
	useEffect(() => {
		if (!token) return;
		const timer = setTimeout(() => {
			fetchData();
		}, 0);
		return () => clearTimeout(timer);
	}, [token, fetchData]);

	const handleTokenSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!tokenInput) return;
		localStorage.setItem("openparcels_admin_token", tokenInput);
		setToken(tokenInput);
		setShowTokenPrompt(false);
	};

	// --- PARCEL HANDLERS ---
	const saveParcel = async (e: React.FormEvent) => {
		e.preventDefault();
		const url = editingParcelId
			? `/api/v1/parcels/${editingParcelId}?token=${token}`
			: `/api/v1/parcels?token=${token}`;

		const method = editingParcelId ? "PATCH" : "POST";

		try {
			const res = await fetch(url, {
				method,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					trackingNumber: parcelForm.trackingNumber,
					courier: parcelForm.courier || null,
					status: parcelForm.status,
					lat: parcelForm.lat ? parseFloat(parcelForm.lat) : null,
					lng: parcelForm.lng ? parseFloat(parcelForm.lng) : null,
				}),
			});

			if (res.ok) {
				setShowParcelModal(false);
				setEditingParcelId(null);
				setParcelForm({
					trackingNumber: "",
					courier: "",
					status: "ordered",
					lat: "",
					lng: "",
				});
				fetchData();
			} else {
				const errData = await res.json();
				alert(`Error saving parcel: ${errData.error || "Unknown error"}`);
			}
		} catch (err) {
			console.error(err);
		}
	};

	const deleteParcel = async (id: number) => {
		if (
			!confirm(
				"Are you sure you want to delete this parcel? All tracking events will also be deleted.",
			)
		)
			return;
		try {
			const res = await fetch(
				`/api/v1/parcels/${id}?token=${token}`,
				{ method: "DELETE" },
			);
			if (res.ok) fetchData();
		} catch (err) {
			console.error(err);
		}
	};

	const openEditParcel = (parcel: Parcel) => {
		setEditingParcelId(parcel.id);
		setParcelForm({
			trackingNumber: parcel.trackingNumber,
			courier: parcel.courier || "",
			status: parcel.status,
			lat: parcel.lat !== null ? parcel.lat.toString() : "",
			lng: parcel.lng !== null ? parcel.lng.toString() : "",
		});
		setShowParcelModal(true);
	};

	// --- ORDER HANDLERS ---
	const saveOrder = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const res = await fetch(
				`/api/v1/orders?token=${token}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(orderForm),
				},
			);
			if (res.ok) {
				setShowOrderModal(false);
				setOrderForm({
					source: "Amazon",
					orderNumber: "",
					status: "processing",
				});
				fetchData();
			}
		} catch (err) {
			console.error(err);
		}
	};

	const deleteOrder = async (id: number) => {
		if (!confirm("Delete this order?")) return;
		try {
			await fetch(`/api/v1/orders/${id}?token=${token}`, {
				method: "DELETE",
			});
			fetchData();
		} catch (err) {
			console.error(err);
		}
	};

	// --- EVENTS HANDLERS ---
	const viewEvents = async (parcelId: number) => {
		setEventParcelId(parcelId);
		try {
			const res = await fetch(
				`/api/v1/parcels/${parcelId}/events?token=${token}`,
			);
			const data = await res.json();
			setSelectedParcelEvents(data);
		} catch (err) {
			console.error(err);
		}
	};

	const addEvent = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!eventParcelId) return;
		try {
			const res = await fetch(
				`/api/v1/parcels/${eventParcelId}/events?token=${token}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: eventForm.location || null,
						description: eventForm.description,
						timestamp: new Date(eventForm.timestamp).toISOString(),
					}),
				},
			);
			if (res.ok) {
				setShowEventModal(false);
				setEventForm({
					location: "",
					description: "",
					timestamp: new Date().toISOString().substring(0, 16),
				});
				viewEvents(eventParcelId);
			}
		} catch (err) {
			console.error(err);
		}
	};

	const deleteEvent = async (id: number) => {
		if (!confirm("Delete this event?")) return;
		try {
			await fetch(`/api/v1/events/${id}?token=${token}`, {
				method: "DELETE",
			});
			if (eventParcelId) viewEvents(eventParcelId);
		} catch (err) {
			console.error(err);
		}
	};

	// --- CREDENTIALS HANDLERS ---
	const saveCredentials = async (e: React.FormEvent) => {
		e.preventDefault();
		const serviceName = credForm.service;

		// Group fields based on service
		let serviceData: Record<string, unknown>;
		if (serviceName === "IMAP") {
			serviceData = {
				username: credForm.username,
				password: credForm.password,
				host: credForm.host,
				port: parseInt(credForm.port || "993", 10),
				tls: credForm.tls === "true",
			};
		} else {
			serviceData = {
				username: credForm.username,
				password: credForm.password,
			};
		}

		try {
			const res = await fetch(
				`/api/v1/credentials?token=${token}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						service: serviceName,
						data: serviceData,
					}),
				},
			);

			if (res.ok) {
				setShowCredModal(false);
				setCredForm({
					service: "IMAP",
					username: "",
					password: "",
					host: "",
					port: "",
					tls: "true",
				});
				fetchData();
			}
		} catch (err) {
			console.error(err);
		}
	};

	const deleteCredentials = async (id: number) => {
		if (
			!confirm(
				"Are you sure you want to delete these credentials? modular scrapers for this service will stop working.",
			)
		)
			return;
		try {
			await fetch(
				`/api/v1/credentials/${id}?token=${token}`,
				{ method: "DELETE" },
			);
			fetchData();
		} catch (err) {
			console.error(err);
		}
	};

	const saveSettings = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const res = await fetch(
				`/api/v1/settings?token=${token}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						timezone: settingsForm.timezone,
						home_name: settingsForm.home_name,
						home_latitude: parseFloat(settingsForm.home_latitude),
						home_longitude: parseFloat(settingsForm.home_longitude),
					}),
				},
			);
			if (res.ok) {
				alert("Settings saved successfully!");
				fetchData();
			} else {
				const errData = await res.json();
				alert(`Error saving settings: ${errData.error || "Unknown error"}`);
			}
		} catch (err) {
			console.error(err);
			alert("Failed to save settings");
		}
	};

	const handleSearchLocation = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!searchQuery.trim()) return;
		try {
			setSearchingLocation(true);
			const res = await fetch(
				`/api/v1/geocode?q=${encodeURIComponent(searchQuery)}&token=${token}`,
			);
			if (res.ok) {
				const data = await res.json();
				setSettingsForm({
					...settingsForm,
					home_latitude: data.lat.toString(),
					home_longitude: data.lng.toString(),
				});
			} else {
				alert("Location not found");
			}
		} catch (err) {
			console.error(err);
			alert("Error searching location");
		} finally {
			setSearchingLocation(false);
		}
	};

	return (
		<div className="manage-container">
			{/* Token Prompt Modal */}
			{showTokenPrompt && (
				<div className="modal-overlay">
					<div className="glass-panel modal-card token-card">
						<ShieldAlert
							size={48}
							className="text-red-400"
							style={{ margin: "0 auto 16px auto", display: "block" }}
						/>
						<h3 style={{ textAlign: "center", marginTop: 0 }}>
							Admin Authentication Required
						</h3>
						<p
							className="text-muted"
							style={{ textAlign: "center", fontSize: "14px" }}
						>
							Please enter your <code>OPENPARCELS_TOKEN_ADMIN</code> token to
							access management panel.
						</p>
						<form onSubmit={handleTokenSubmit}>
							<div className="form-group">
								<input
									type="password"
									className="input"
									placeholder="Enter admin token..."
									value={tokenInput}
									onChange={(e) => setTokenInput(e.target.value)}
									required
								/>
							</div>
							<button
								type="submit"
								className="btn btn-primary"
								style={{ width: "100%" }}
							>
								Authenticate
							</button>
						</form>
					</div>
				</div>
			)}

			{/* Main Admin UI */}
			{!showTokenPrompt && (
				<>
					<div className="manage-header">
						<div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
							<a href="/" className="btn-icon">
								<ArrowLeft size={20} />
							</a>
							<h2 style={{ margin: 0 }}>Admin Management Console</h2>
						</div>

						<div className="manage-tabs glass-panel">
							<button
								className={`manage-tab ${activeTab === "parcels" ? "active" : ""}`}
								onClick={() => setActiveTab("parcels")}
							>
								<Package size={16} />
								<span>Parcels</span>
							</button>
							<button
								className={`manage-tab ${activeTab === "orders" ? "active" : ""}`}
								onClick={() => setActiveTab("orders")}
							>
								<Clipboard size={16} />
								<span>Orders</span>
							</button>
							<button
								className={`manage-tab ${activeTab === "credentials" ? "active" : ""}`}
								onClick={() => setActiveTab("credentials")}
							>
								<Key size={16} />
								<span>Credentials</span>
							</button>
							<button
								className={`manage-tab ${activeTab === "settings" ? "active" : ""}`}
								onClick={() => setActiveTab("settings")}
							>
								<Settings size={16} />
								<span>Settings</span>
							</button>
						</div>
					</div>

					<div className="manage-content">
						{/* PARCELS TAB */}
						{activeTab === "parcels" && (
							<div className="manage-grid">
								<div className="glass-panel main-list-panel">
									<div className="panel-header-actions">
										<h3 className="panel-title" style={{ margin: 0 }}>
											Parcels
										</h3>
										<button
											className="btn btn-primary btn-sm"
											onClick={() => {
												setEditingParcelId(null);
												setParcelForm({
													trackingNumber: "",
													courier: "",
													status: "ordered",
													lat: "",
													lng: "",
												});
												setShowParcelModal(true);
											}}
										>
											<Plus size={14} /> Add Parcel
										</button>
									</div>

									<div className="table-wrapper">
										<table className="table">
											<thead>
												<tr>
													<th>Tracking ID</th>
													<th>Courier</th>
													<th>Status</th>
													<th>Coordinates</th>
													<th style={{ textAlign: "right" }}>Actions</th>
												</tr>
											</thead>
											<tbody>
												{parcels.map((parcel) => (
													<tr
														key={parcel.id}
														className={
															eventParcelId === parcel.id ? "active-row" : ""
														}
														onClick={() => viewEvents(parcel.id)}
													>
														<td className="bold-cell">
															{parcel.trackingNumber}
														</td>
														<td>{parcel.courier || "N/A"}</td>
														<td>
															<span
																className={`status-tag status-${parcel.status}`}
															>
																{parcel.status}
															</span>
														</td>
														<td>
															{typeof parcel.lat === "number" && typeof parcel.lng === "number"
																? `${parcel.lat.toFixed(3)}, ${parcel.lng.toFixed(3)}`
																: "None"}
														</td>
														<td
															style={{ textAlign: "right" }}
															onClick={(e) => e.stopPropagation()}
														>
															<div
																style={{
																	display: "flex",
																	gap: "8px",
																	justifyContent: "flex-end",
																}}
															>
																<button
																	className="btn-icon-sm"
																	onClick={() => openEditParcel(parcel)}
																>
																	<Edit2 size={14} />
																</button>
																<button
																	className="btn-icon-sm text-red"
																	onClick={() => deleteParcel(parcel.id)}
																>
																	<Trash2 size={14} />
																</button>
															</div>
														</td>
													</tr>
												))}
												{parcels.length === 0 && (
													<tr>
														<td
															colSpan={5}
															style={{ textAlign: "center", padding: "32px" }}
															className="text-muted"
														>
															No parcels found in database.
														</td>
													</tr>
												)}
											</tbody>
										</table>
									</div>
								</div>

								{/* Sub Panel: Events */}
								<div className="glass-panel sub-detail-panel">
									<div className="panel-header-actions">
										<h3 className="panel-title" style={{ margin: 0 }}>
											Events {eventParcelId ? `(Parcel #${eventParcelId})` : ""}
										</h3>
										{eventParcelId && (
											<button
												className="btn btn-primary btn-sm"
												onClick={() => setShowEventModal(true)}
											>
												<Plus size={14} /> Add Event
											</button>
										)}
									</div>

									{!eventParcelId ? (
										<div
											className="flex-center text-muted"
											style={{ height: "200px" }}
										>
											Click on a parcel row to manage its tracking events.
										</div>
									) : (
										<div className="event-list">
											{selectedParcelEvents.map((event) => (
												<div key={event.id} className="event-card">
													<div className="event-header">
														<span className="event-location">
															<MapPin size={12} />{" "}
															{event.location || "In Transit"}
														</span>
														<button
															className="btn-icon-sm text-red"
															onClick={() => deleteEvent(event.id)}
														>
															<Trash2 size={12} />
														</button>
													</div>
													<div className="event-desc">{event.description}</div>
													<div className="event-time">
														<Calendar size={12} />{" "}
														{new Date(event.timestamp).toLocaleString()}
													</div>
												</div>
											))}
											{selectedParcelEvents.length === 0 && (
												<div
													className="text-muted"
													style={{ textAlign: "center", padding: "32px" }}
												>
													No tracking events logged for this parcel.
												</div>
											)}
										</div>
									)}
								</div>
							</div>
						)}

						{/* ORDERS TAB */}
						{activeTab === "orders" && (
							<div className="glass-panel">
								<div className="panel-header-actions">
									<h3 className="panel-title" style={{ margin: 0 }}>
										Orders
									</h3>
									<button
										className="btn btn-primary btn-sm"
										onClick={() => setShowOrderModal(true)}
									>
										<Plus size={14} /> Add Order
									</button>
								</div>

								<div className="table-wrapper">
									<table className="table">
										<thead>
											<tr>
												<th>Order Number</th>
												<th>Store/Source</th>
												<th>Status</th>
												<th>Date Added</th>
												<th style={{ textAlign: "right" }}>Actions</th>
											</tr>
										</thead>
										<tbody>
											{orders.map((order) => (
												<tr key={order.id}>
													<td className="bold-cell">{order.orderNumber}</td>
													<td>{order.source}</td>
													<td>
														<span
															className={`status-tag status-${order.status}`}
														>
															{order.status}
														</span>
													</td>
													<td>
														{new Date(order.createdAt).toLocaleDateString()}
													</td>
													<td style={{ textAlign: "right" }}>
														<button
															className="btn-icon-sm text-red"
															onClick={() => deleteOrder(order.id)}
														>
															<Trash2 size={14} />
														</button>
													</td>
												</tr>
											))}
											{orders.length === 0 && (
												<tr>
													<td
														colSpan={5}
														style={{ textAlign: "center", padding: "32px" }}
														className="text-muted"
													>
														No orders found in database.
													</td>
												</tr>
											)}
										</tbody>
									</table>
								</div>
							</div>
						)}

						{/* CREDENTIALS TAB */}
						{activeTab === "credentials" && (
							<div className="glass-panel">
								<div className="panel-header-actions">
									<h3 className="panel-title" style={{ margin: 0 }}>
										{" "}
										modular Scrapers Credentials
									</h3>
									<button
										className="btn btn-primary btn-sm"
										onClick={() => setShowCredModal(true)}
									>
										<Plus size={14} /> Setup Service
									</button>
								</div>

								<div className="table-wrapper">
									<table className="table">
										<thead>
											<tr>
												<th>Service</th>
												<th>Last Modified</th>
												<th style={{ textAlign: "right" }}>Actions</th>
											</tr>
										</thead>
										<tbody>
											{credentialsList.map((cred) => (
												<tr key={cred.id}>
													<td
														className="bold-cell"
														style={{
															display: "flex",
															alignItems: "center",
															gap: "8px",
														}}
													>
														<Key size={14} className="text-yellow-400" />
														{cred.service}
													</td>
													<td>{new Date(cred.updatedAt).toLocaleString()}</td>
													<td style={{ textAlign: "right" }}>
														<button
															className="btn-icon-sm text-red"
															onClick={() => deleteCredentials(cred.id)}
														>
															<Trash2 size={14} />
														</button>
													</td>
												</tr>
											))}
											{credentialsList.length === 0 && (
												<tr>
													<td
														colSpan={3}
														style={{ textAlign: "center", padding: "32px" }}
														className="text-muted"
													>
														No scraper credentials stored. Modular scrapers will
														use defaults or skip.
													</td>
												</tr>
											)}
										</tbody>
									</table>
								</div>
							</div>
						)}

						{/* SETTINGS TAB */}
						{activeTab === "settings" && (
							<div
								className="manage-grid"
								style={{ gridTemplateColumns: "1.2fr 1fr" }}
							>
								<div
									className="glass-panel main-list-panel"
									style={{ padding: "24px" }}
								>
									<h3 className="panel-title" style={{ margin: "0 0 20px 0" }}>
										App Settings
									</h3>

									{/* Search Place Input Form */}
									<form
										onSubmit={handleSearchLocation}
										style={{
											display: "flex",
											gap: "8px",
											marginBottom: "24px",
											background: "rgba(0,0,0,0.1)",
											padding: "12px",
											borderRadius: "10px",
											border: "1px solid rgba(255,255,255,0.03)",
										}}
									>
										<div
											style={{
												flex: 1,
												display: "flex",
												flexDirection: "column",
												gap: "4px",
											}}
										>
											<label className="label" style={{ fontSize: "11px" }}>
												Search Place / City (e.g. Frankfurt, Berlin)
											</label>
											<input
												type="text"
												className="input"
												placeholder="Search for a location..."
												value={searchQuery}
												onChange={(e) => setSearchQuery(e.target.value)}
												style={{ padding: "8px 12px" }}
											/>
										</div>
										<button
											type="submit"
											disabled={searchingLocation}
											className="btn btn-primary"
											style={{
												alignSelf: "flex-end",
												height: "40px",
												padding: "0 16px",
											}}
										>
											{searchingLocation ? "Searching..." : "Search"}
										</button>
									</form>

									<form
										onSubmit={saveSettings}
										style={{
											display: "flex",
											flexDirection: "column",
											gap: "20px",
										}}
									>
										<div className="form-group">
											<label className="label">Timezone</label>
											<input
												type="text"
												className="input"
												value={settingsForm.timezone}
												onChange={(e) =>
													setSettingsForm({
														...settingsForm,
														timezone: e.target.value,
													})
												}
												placeholder="e.g. Europe/Berlin"
												required
											/>
											<small
												className="text-muted"
												style={{ fontSize: "11px", marginTop: "4px" }}
											>
												Timezone used for tracking calculations.
											</small>
										</div>

										<div className="form-group">
											<label className="label">Home Destination Name</label>
											<input
												type="text"
												className="input"
												value={settingsForm.home_name}
												onChange={(e) =>
													setSettingsForm({
														...settingsForm,
														home_name: e.target.value,
													})
												}
												placeholder="e.g. Home (Frankfurt)"
												required
											/>
										</div>

										<div className="form-row">
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Home Latitude</label>
												<input
													type="number"
													step="0.000001"
													className="input"
													value={settingsForm.home_latitude}
													onChange={(e) =>
														setSettingsForm({
															...settingsForm,
															home_latitude: e.target.value,
														})
													}
													placeholder="e.g. 50.1109"
													required
												/>
											</div>
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Home Longitude</label>
												<input
													type="number"
													step="0.000001"
													className="input"
													value={settingsForm.home_longitude}
													onChange={(e) =>
														setSettingsForm({
															...settingsForm,
															home_longitude: e.target.value,
														})
													}
													placeholder="e.g. 8.6821"
													required
												/>
											</div>
										</div>

										<button
											type="submit"
											className="btn btn-primary"
											style={{ alignSelf: "flex-start", marginTop: "10px" }}
										>
											Save Settings
										</button>
									</form>
								</div>

								{/* Leaflet Map coordinates picker panel */}
								<div
									className="glass-panel sub-detail-panel"
									style={{
										padding: "24px",
										display: "flex",
										flexDirection: "column",
									}}
								>
									<h3 className="panel-title" style={{ margin: "0 0 12px 0" }}>
										Click Map to Pin Home
									</h3>
									<p
										className="text-muted"
										style={{ fontSize: "12px", margin: "0 0 16px 0" }}
									>
										Click anywhere on the map below to instantly select it as
										your home destination location.
									</p>
									<div
										style={{
											flex: 1,
											borderRadius: "12px",
											overflow: "hidden",
											minHeight: "300px",
											border: "1px solid var(--panel-border)",
										}}
									>
										<MapContainer
											center={[
												parseFloat(settingsForm.home_latitude) || 50.1109,
												parseFloat(settingsForm.home_longitude) || 8.6821,
											]}
											zoom={12}
											scrollWheelZoom={true}
											style={{ height: "100%", width: "100%" }}
										>
											<TileLayer
												attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
												url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
											/>
											{parseFloat(settingsForm.home_latitude) &&
												parseFloat(settingsForm.home_longitude) &&
												!Number.isNaN(parseFloat(settingsForm.home_latitude)) &&
												!Number.isNaN(
													parseFloat(settingsForm.home_longitude),
												) && (
													<Marker
														position={[
															parseFloat(settingsForm.home_latitude),
															parseFloat(settingsForm.home_longitude),
														]}
													/>
												)}
											<MapUpdater
												lat={parseFloat(settingsForm.home_latitude)}
												lng={parseFloat(settingsForm.home_longitude)}
											/>
											<MapClickHandler
												onClick={(lat, lng) => {
													setSettingsForm({
														...settingsForm,
														home_latitude: lat.toFixed(6),
														home_longitude: lng.toFixed(6),
													});
												}}
											/>
										</MapContainer>
									</div>
								</div>
							</div>
						)}
					</div>
				</>
			)}

			{/* --- POPUP FORM MODALS --- */}

			{/* Parcel Form Modal */}
			{showParcelModal && (
				<div className="modal-overlay">
					<div className="glass-panel modal-card">
						<div className="modal-header">
							<h3>{editingParcelId ? "Edit Parcel" : "Add New Parcel"}</h3>
							<button
								className="btn-icon-sm"
								onClick={() => setShowParcelModal(false)}
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
										placeholder="e.g. 1Z999XX9999999"
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
										placeholder="e.g. DHL, UPS, FedEx"
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
										<option value="sent">Sent</option>
										<option value="arriving">Arriving Today</option>
										<option value="delivered">Delivered</option>
										<option value="return-sent">Return Sent</option>
										<option value="return-accepted">Return Accepted</option>
									</select>
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
											placeholder="e.g. 48.135"
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
											placeholder="e.g. 11.582"
										/>
									</div>
								</div>
							</div>
							<div className="modal-footer">
								<button
									type="button"
									className="btn"
									onClick={() => setShowParcelModal(false)}
								>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary">
									Save Parcel
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Order Form Modal */}
			{showOrderModal && (
				<div className="modal-overlay">
					<div className="glass-panel modal-card">
						<div className="modal-header">
							<h3>Create Order Record</h3>
							<button
								className="btn-icon-sm"
								onClick={() => setShowOrderModal(false)}
							>
								<X size={16} />
							</button>
						</div>
						<form onSubmit={saveOrder}>
							<div className="modal-body">
								<div className="form-group">
									<label className="label">Order Number *</label>
									<input
										type="text"
										className="input"
										value={orderForm.orderNumber}
										onChange={(e) =>
											setOrderForm({
												...orderForm,
												orderNumber: e.target.value,
											})
										}
										required
										placeholder="e.g. 302-1234567-12345"
									/>
								</div>
								<div className="form-group">
									<label className="label">Source Store *</label>
									<select
										className="select"
										value={orderForm.source}
										onChange={(e) =>
											setOrderForm({ ...orderForm, source: e.target.value })
										}
									>
										<option value="Amazon">Amazon</option>
										<option value="eBay">eBay</option>
										<option value="AliExpress">AliExpress</option>
										<option value="Wish">Wish</option>
										<option value="Temu">Temu</option>
									</select>
								</div>
								<div className="form-group">
									<label className="label">Status</label>
									<select
										className="select"
										value={orderForm.status}
										onChange={(e) =>
											setOrderForm({ ...orderForm, status: e.target.value })
										}
									>
										<option value="processing">Processing</option>
										<option value="shipped">Shipped</option>
										<option value="delivered">Delivered</option>
									</select>
								</div>
							</div>
							<div className="modal-footer">
								<button
									type="button"
									className="btn"
									onClick={() => setShowOrderModal(false)}
								>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary">
									Create Order
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Event Form Modal */}
			{showEventModal && (
				<div className="modal-overlay">
					<div className="glass-panel modal-card">
						<div className="modal-header">
							<h3>Add Tracking Event</h3>
							<button
								className="btn-icon-sm"
								onClick={() => setShowEventModal(false)}
							>
								<X size={16} />
							</button>
						</div>
						<form onSubmit={addEvent}>
							<div className="modal-body">
								<div className="form-group">
									<label className="label">Location</label>
									<input
										type="text"
										className="input"
										value={eventForm.location}
										onChange={(e) =>
											setEventForm({ ...eventForm, location: e.target.value })
										}
										placeholder="e.g. Distribution Center Munich"
									/>
								</div>
								<div className="form-group">
									<label className="label">Description *</label>
									<input
										type="text"
										className="input"
										value={eventForm.description}
										onChange={(e) =>
											setEventForm({
												...eventForm,
												description: e.target.value,
											})
										}
										required
										placeholder="e.g. Parcel has arrived at regional sorting hub"
									/>
								</div>
								<div className="form-group">
									<label className="label">Timestamp</label>
									<input
										type="datetime-local"
										className="input"
										value={eventForm.timestamp}
										onChange={(e) =>
											setEventForm({ ...eventForm, timestamp: e.target.value })
										}
									/>
								</div>
							</div>
							<div className="modal-footer">
								<button
									type="button"
									className="btn"
									onClick={() => setShowEventModal(false)}
								>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary">
									Add Event
								</button>
							</div>
						</form>
					</div>
				</div>
			)}

			{/* Credentials Form Modal */}
			{showCredModal && (
				<div className="modal-overlay">
					<div className="glass-panel modal-card">
						<div className="modal-header">
							<h3>Setup Service Credentials</h3>
							<button
								className="btn-icon-sm"
								onClick={() => setShowCredModal(false)}
							>
								<X size={16} />
							</button>
						</div>
						<form onSubmit={saveCredentials}>
							<div className="modal-body">
								<div className="form-group">
									<label className="label">Service Name *</label>
									<select
										className="select"
										value={credForm.service}
										onChange={(e) =>
											setCredForm({ ...credForm, service: e.target.value })
										}
									>
										<option value="IMAP">Email Ingestion (IMAP)</option>
										<option value="Amazon">Amazon.de/com Scraper</option>
										<option value="eBay">eBay.de/com Scraper</option>
										<option value="AliExpress">AliExpress Scraper</option>
										<option value="Wish">Wish Scraper</option>
										<option value="Temu">Temu Scraper</option>
									</select>
								</div>

								<div className="form-group">
									<label className="label">Username/Email *</label>
									<input
										type="text"
										className="input"
										value={credForm.username}
										onChange={(e) =>
											setCredForm({ ...credForm, username: e.target.value })
										}
										required
										placeholder="Username or email address"
									/>
								</div>

								<div className="form-group">
									<label className="label">Password/Secret key *</label>
									<input
										type="password"
										className="input"
										value={credForm.password}
										onChange={(e) =>
											setCredForm({ ...credForm, password: e.target.value })
										}
										required
										placeholder="Enter password/app-token"
									/>
								</div>

								{credForm.service === "IMAP" && (
									<>
										<div className="form-group">
											<label className="label">IMAP Host *</label>
											<input
												type="text"
												className="input"
												value={credForm.host}
												onChange={(e) =>
													setCredForm({ ...credForm, host: e.target.value })
												}
												required
												placeholder="e.g. imap.gmail.com"
											/>
										</div>
										<div className="form-row">
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Port *</label>
												<input
													type="number"
													className="input"
													value={credForm.port}
													onChange={(e) =>
														setCredForm({ ...credForm, port: e.target.value })
													}
													required
													placeholder="e.g. 993"
												/>
											</div>
											<div className="form-group" style={{ flex: 1 }}>
												<label className="label">Use TLS</label>
												<select
													className="select"
													value={credForm.tls}
													onChange={(e) =>
														setCredForm({ ...credForm, tls: e.target.value })
													}
												>
													<option value="true">Yes</option>
													<option value="false">No</option>
												</select>
											</div>
										</div>
									</>
								)}
							</div>
							<div className="modal-footer">
								<button
									type="button"
									className="btn"
									onClick={() => setShowCredModal(false)}
								>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary">
									Save Credentials
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</div>
	);
};
