/* biome-ignore-all lint/suspicious/noExplicitAny: fastify handlers use any for request/reply */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
import { Map, Package, Shield, ShoppingBag, Plus } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { ManageInterface } from "./components/ManageInterface";
import { MapDashboard } from "./components/MapDashboard";
import { OrderDetail } from "./components/OrderDetail";
import { OrdersTable } from "./components/OrdersTable";
import { ParcelDetail } from "./components/ParcelDetail";
import { ParcelsTable } from "./components/ParcelsTable";
import { getGuestToken } from "./utils/auth";
import "./index.css";

interface ToastInfo {
	id: number;
	title: string;
	message: string;
	trackingNumber: string;
}

function parseTrackingAndOrder(input: string) {
	let trackingNumber = "";
	let orderNumber = "";
	let source = "";

	const trimmed = input.trim();
	if (!trimmed) return { trackingNumber, orderNumber, source };

	// Check if it's a URL
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		try {
			const parseUrlParams = (urlString: string) => {
				const url = new URL(urlString);
				
				// Extract source
				if (url.hostname.includes("amazon")) {
					source = "Amazon";
				} else if (url.hostname.includes("ebay")) {
					source = "eBay";
				} else if (url.hostname.includes("dhl")) {
					source = "DHL";
				}

				// Check query parameters
				const params = new URLSearchParams(url.search);
				for (const [key, val] of params.entries()) {
					const lowerKey = key.toLowerCase();
					if (lowerKey === "orderid" || lowerKey === "ordernumber" || lowerKey === "order_id" || lowerKey === "order_number") {
						orderNumber = val;
					} else if (lowerKey === "shipmentid" || lowerKey === "tracking" || lowerKey === "trackingid" || lowerKey === "trackingnumber" || lowerKey === "tracking_number" || lowerKey === "shipment_id") {
						trackingNumber = val;
					}
					
					// Recursively check if the value is itself a URL
					if (val.startsWith("http://") || val.startsWith("https://")) {
						parseUrlParams(val);
					}
				}

				// Fallback to path parsing if not found in query params
				if (!trackingNumber) {
					// e.g. /parcel/JD000000001/ or /track/1Z99999...
					const pathParts = url.pathname.split("/");
					for (let i = 0; i < pathParts.length; i++) {
						const part = pathParts[i];
						if (part === "parcel" || part === "track" || part === "package") {
							const nextPart = pathParts[i + 1];
							if (nextPart) {
								trackingNumber = nextPart;
							}
						}
					}
				}
			};

			parseUrlParams(trimmed);
		} catch (e) {
			console.error("URL parsing failed:", e);
		}
	}

	// If it's not a URL, or URL parsing didn't find both:
	if (!trackingNumber && !orderNumber) {
		// Detect if it looks like an Amazon order number (e.g. 305-1827771-7197161)
		const amazonOrderRegex = /\b\d{3}-\d{7}-\d{7}\b/;
		const match = trimmed.match(amazonOrderRegex);
		if (match) {
			orderNumber = match[0];
			const remaining = trimmed.replace(orderNumber, "").trim();
			if (remaining && /^[a-zA-Z0-9]+$/.test(remaining)) {
				trackingNumber = remaining;
			}
		} else {
			if (trimmed.includes("-") && /\d/.test(trimmed)) {
				orderNumber = trimmed;
			} else {
				trackingNumber = trimmed;
			}
		}
	}

	return { trackingNumber, orderNumber, source };
}

function App() {
	const [currentPath, setCurrentPath] = useState(window.location.pathname);
	const [toasts, setToasts] = useState<ToastInfo[]>([]);

	// Add Parcel Modal States
	const [isAddModalOpen, setIsAddModalOpen] = useState(false);
	const [rawInput, setRawInput] = useState("");
	const [newTrackingNumber, setNewTrackingNumber] = useState("");
	const [newOrderNumber, setNewOrderNumber] = useState("");
	const [newName, setNewName] = useState("");
	const [newCourier, setNewCourier] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState("");
	const [isResolvingLink, setIsResolvingLink] = useState(false);
	const [resolveSeconds, setResolveSeconds] = useState(0);
	const [submitSeconds, setSubmitSeconds] = useState(0);

	useEffect(() => {
		let interval: any;
		if (isResolvingLink) {
			setResolveSeconds(0);
			interval = setInterval(() => {
				setResolveSeconds((s) => s + 1);
			}, 1000);
		} else {
			setResolveSeconds(0);
		}
		return () => clearInterval(interval);
	}, [isResolvingLink]);

	useEffect(() => {
		let interval: any;
		if (isSubmitting) {
			setSubmitSeconds(0);
			interval = setInterval(() => {
				setSubmitSeconds((s) => s + 1);
			}, 1000);
		} else {
			setSubmitSeconds(0);
		}
		return () => clearInterval(interval);
	}, [isSubmitting]);

	useEffect(() => {
		const handleLocationChange = () => {
			setCurrentPath(window.location.pathname);
		};

		window.addEventListener("popstate", handleLocationChange);
		return () => window.removeEventListener("popstate", handleLocationChange);
	}, []);

	useEffect(() => {
		const token = getGuestToken();
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${window.location.host}/api/v1/ws?token=${token}`;

		let ws: WebSocket;
		let reconnectTimeout: number | undefined;

		function connect() {
			console.log("[WS-Client] Connecting to WebSocket...");
			ws = new WebSocket(wsUrl);

			ws.onopen = () => {
				console.log("[WS-Client] WebSocket connection established.");
				ws.send(JSON.stringify({ action: "subscribe", topic: "all" }));
			};

			ws.onmessage = (event) => {
				try {
					const payload = JSON.parse(event.data);
					if (payload.event === "parcel_update" && payload.data) {
						const data = payload.data;
						console.log("[WS-Client] Received update:", data);

						// Dispatch global event for components to listen to
						window.dispatchEvent(
							new CustomEvent("parcel-update", { detail: data }),
						);

						// Add a toast notification
						const parcelNameStr = data.name
							? `${data.name} (${data.trackingNumber})`
							: data.trackingNumber;
						const statusDesc = data.calloutMessage
							? `${data.calloutMessage}: ${data.secondaryStatus}`
							: `Driver is ${data.stopsRemaining} stops away. Status: ${data.status}`;

						const toastId = Date.now();
						setToasts((prev) => [
							...prev,
							{
								id: toastId,
								title: `Parcel Update: ${parcelNameStr}`,
								message: statusDesc,
								trackingNumber: data.trackingNumber,
							},
						]);

						setTimeout(() => {
							setToasts((prev) => prev.filter((t) => t.id !== toastId));
						}, 6000);
					}
				} catch (err) {
					console.error("[WS-Client] Error handling WS message:", err);
				}
			};

			ws.onclose = () => {
				console.log(
					"[WS-Client] WebSocket connection closed, reconnecting in 5s...",
				);
				reconnectTimeout = setTimeout(connect, 5000);
			};

			ws.onerror = (err) => {
				console.error("[WS-Client] WebSocket error:", err);
				ws.close();
			};
		}

		connect();

		return () => {
			if (ws) ws.close();
			clearTimeout(reconnectTimeout);
		};
	}, []);

	const navigateTo = (path: string, e?: React.MouseEvent) => {
		if (e) e.preventDefault();
		window.history.pushState({}, "", path);
		setCurrentPath(path);
	};

	const handleRawInputChange = async (val: string) => {
		setRawInput(val);
		
		// Quick local regex/parameter parsing as instant feedback
		const parsed = parseTrackingAndOrder(val);
		if (parsed.trackingNumber) setNewTrackingNumber(parsed.trackingNumber);
		if (parsed.orderNumber) setNewOrderNumber(parsed.orderNumber);
		if (parsed.source) setNewCourier(parsed.source);

		// If it looks like an Amazon track or details URL, trigger the live scraper preview in background!
		if (
			val.trim().startsWith("http") &&
			val.includes("amazon.") &&
			(val.includes("orderId") || val.includes("orderID") || val.includes("shipmentId") || val.includes("shipment_id") || val.includes("order-details"))
		) {
			try {
				setIsResolvingLink(true);
				setError("");
				// Temporarily clear fields to indicate fresh loading
				setNewTrackingNumber("");
				setNewOrderNumber("");
				setNewName("");
				setNewCourier("Amazon");

				const res = await fetch(`/api/v1/parcels/preview?token=${getGuestToken()}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ url: val.trim() }),
				});

				if (res.ok) {
					const data = await res.json();
					if (data.trackingNumber) setNewTrackingNumber(data.trackingNumber);
					if (data.orderNumber) setNewOrderNumber(data.orderNumber);
					if (data.itemName) setNewName(data.itemName);
					setNewCourier("Amazon");
				} else {
					const errData = await res.json().catch(() => ({}));
					console.warn("Live link preview failed, keeping fallback query parameters:", errData.error);
					// Restore fallback parameters if preview scraping fails
					if (parsed.trackingNumber) setNewTrackingNumber(parsed.trackingNumber);
					if (parsed.orderNumber) setNewOrderNumber(parsed.orderNumber);
				}
			} catch (err) {
				console.error("Link preview error:", err);
				// Restore fallback parameters
				if (parsed.trackingNumber) setNewTrackingNumber(parsed.trackingNumber);
				if (parsed.orderNumber) setNewOrderNumber(parsed.orderNumber);
			} finally {
				setIsResolvingLink(false);
			}
		}
	};

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault();
		const tracking = newTrackingNumber.trim();
		const order = newOrderNumber.trim();
		const name = newName.trim();
		const courier = newCourier.trim();

		if (!tracking && !order) {
			setError("Please enter at least a Tracking Number or an Order Number.");
			return;
		}

		setIsSubmitting(true);
		setError("");

		try {
			let createdOrderId: number | null = null;

			if (order) {
				const res = await fetch(`/api/v1/orders?token=${getGuestToken()}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						orderNumber: order,
						source: courier || "Amazon",
						status: "ordered",
					}),
				});

				if (!res.ok) {
					const data = await res.json().catch(() => ({}));
					throw new Error(data.error || `HTTP error! Status: ${res.status}`);
				}
				const data = await res.json();
				createdOrderId = data.id;
			}

			if (tracking) {
				const res = await fetch(`/api/v1/parcels?token=${getGuestToken()}`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						trackingNumber: tracking,
						status: "ordered",
						name: name || undefined,
						courier: courier || undefined,
						orderId: createdOrderId || undefined,
					}),
				});

				if (!res.ok) {
					const data = await res.json().catch(() => ({}));
					throw new Error(data.error || `HTTP error! Status: ${res.status}`);
				}
			}

			// Clear form and close modal
			setRawInput("");
			setNewTrackingNumber("");
			setNewOrderNumber("");
			setNewName("");
			setNewCourier("");
			setIsAddModalOpen(false);

			// Navigate to details or orders page
			if (tracking) {
				navigateTo(`/parcel/${tracking}/`);
			} else {
				navigateTo("/orders");
			}
		} catch (err: any) {
			console.error("Failed to add:", err);
			setError(err.message || "An unexpected error occurred.");
		} finally {
			setIsSubmitting(false);
		}
	};

	const isManage = currentPath.startsWith("/manage");
	const parcelMatch = currentPath.match(/^\/parcel\/([^/]+)\/?$/);
	const selectedTrackingNumber = parcelMatch ? parcelMatch[1] : null;
	const orderMatch = currentPath.match(/^\/order\/([^/]+)\/?$/);
	const selectedOrderId = orderMatch ? orderMatch[1] : null;
	const isParcelsTable = currentPath === "/parcels";
	const isOrdersTable = currentPath === "/orders";
	const isMap = !isManage && !selectedTrackingNumber && !selectedOrderId && !isParcelsTable && !isOrdersTable;

	const navLink = (path: string) =>
		currentPath === path || (path === "/" && isMap) ? "nav-link active" : "nav-link";

	return (
		<>
			{!isManage && (
				<header className="app-header">
					<h1
						className="app-title"
						style={{ cursor: "pointer" }}
						onClick={() => navigateTo("/")}
					>
						OpenParcels
					</h1>

					<nav className="app-nav">
						<a
							href="/"
							id="nav-live-map"
							className={navLink("/")}
							onClick={(e) => navigateTo("/", e)}
						>
							<Map size={15} />
							<span>Live Map</span>
						</a>
						<a
							href="/parcels"
							id="nav-parcels"
							className={navLink("/parcels")}
							onClick={(e) => navigateTo("/parcels", e)}
						>
							<Package size={15} />
							<span>Parcels</span>
						</a>
						<a
							href="/orders"
							id="nav-orders"
							className={navLink("/orders")}
							onClick={(e) => navigateTo("/orders", e)}
						>
							<ShoppingBag size={15} />
							<span>Orders</span>
						</a>
					</nav>

					<div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
						<button
							type="button"
							onClick={() => setIsAddModalOpen(true)}
							className="add-parcel-btn-header"
							style={{
								display: "flex",
								alignItems: "center",
								gap: "6px",
								color: "var(--text-muted)",
								background: "none",
								border: "none",
								cursor: "pointer",
								fontSize: "14px",
								fontWeight: 500,
								padding: 0,
								fontFamily: "var(--font-family)",
								transition: "color 0.2s ease",
							}}
							onMouseOver={(e) => (e.currentTarget.style.color = "var(--text-main)")}
							onMouseOut={(e) => (e.currentTarget.style.color = "var(--text-muted)")}
						>
							<Plus size={16} />
							<span>Add</span>
						</button>
						<a
							href="/manage"
							onClick={(e) => navigateTo("/manage", e)}
							className="admin-link-header"
							style={{
								display: "flex",
								alignItems: "center",
								gap: "6px",
								color: "var(--text-muted)",
								textDecoration: "none",
								fontSize: "14px",
								fontWeight: 500,
							}}
						>
							<Shield size={16} />
							<span>Manage</span>
						</a>
					</div>
				</header>
			)}
			{isManage ? (
				<ManageInterface />
			) : selectedTrackingNumber ? (
				<ParcelDetail
					trackingNumber={selectedTrackingNumber}
					onBack={() => {
						if (window.history.length > 1) {
							window.history.back();
						} else {
							navigateTo("/");
						}
					}}
				/>
			) : selectedOrderId ? (
				<OrderDetail
					orderId={selectedOrderId}
					onBack={() => {
						if (window.history.length > 1) {
							window.history.back();
						} else {
							navigateTo("/orders");
						}
					}}
					onSelectParcel={(trackingNr) => navigateTo(`/parcel/${trackingNr}/`)}
				/>
			) : isParcelsTable ? (
				<ParcelsTable
					onSelectParcel={(trackingNr) => navigateTo(`/parcel/${trackingNr}/`)}
				/>
			) : isOrdersTable ? (
				<OrdersTable
					onSelectOrder={(id) => navigateTo(`/order/${id}/`)}
				/>
			) : (
				<MapDashboard
					onSelectParcel={(trackingNr) => navigateTo(`/parcel/${trackingNr}/`)}
				/>
			)}


			{/* Toast Notifications */}
			<div className="toast-container">
				{toasts.map((toast) => (
					<div
						key={toast.id}
						className="toast-card glass-panel"
						onClick={() => navigateTo(`/parcel/${toast.trackingNumber}/`)}
					>
						<div className="toast-glow" />
						<div className="toast-header">
							<span className="toast-title">{toast.title}</span>
							<button
								className="toast-close"
								onClick={(e) => {
									e.stopPropagation();
									setToasts((prev) => prev.filter((t) => t.id !== toast.id));
								}}
							>
								&times;
							</button>
						</div>
						<div className="toast-body">{toast.message}</div>
					</div>
				))}
			</div>

			{/* Add Modal */}
			{isAddModalOpen && (
				<div className="modal-overlay" onClick={() => setIsAddModalOpen(false)}>
					<div className="modal-card" onClick={(e) => e.stopPropagation()}>
						<div className="modal-header">
							<h3>Add Tracking or Order</h3>
							<button className="btn-icon-sm" onClick={() => setIsAddModalOpen(false)}>
								&times;
							</button>
						</div>
						<form onSubmit={handleAdd}>
							<div className="modal-body">
								{error && <div style={{ color: "#f87171", fontSize: "14px" }}>{error}</div>}
								<div className="form-group">
									<label className="label">Paste Link, Tracking, or Order Number</label>
									<textarea
										className="input"
										style={{ minHeight: "60px", resize: "vertical", fontFamily: "var(--font-family)" }}
										placeholder="Paste Amazon link, tracking number, or order number..."
										value={rawInput}
										onChange={(e) => handleRawInputChange(e.target.value)}
										autoFocus
										readOnly={isResolvingLink || isSubmitting}
									/>
								</div>
								
								{isResolvingLink && (
									<div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#60a5fa", fontSize: "13px", margin: "8px 0 16px 0", background: "rgba(96,165,250,0.1)", padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(96,165,250,0.2)" }}>
										<div className="spinner-sm" style={{ width: "16px", height: "16px", border: "2px solid rgba(96,165,250,0.2)", borderTopColor: "#60a5fa", borderRadius: "50%", animation: "spin 0.8s linear infinite" }}></div>
										<span style={{ fontWeight: "500" }}>
											{resolveSeconds > 3
												? `Logging in and scraping (Queued/Rate-Limited, waiting ${resolveSeconds}s)...`
												: "Logging in and scraping actual Tracking ID & friendly item name..."}
										</span>
									</div>
								)}

								<div className="form-row" style={{ display: "flex", gap: "12px" }}>
									<div className="form-group" style={{ flex: 1 }}>
										<label className="label">Tracking Number</label>
										<input
											type="text"
											className="input"
											placeholder={isResolvingLink ? "Loading actual ID..." : "e.g. DE5525979947"}
											value={newTrackingNumber}
											onChange={(e) => setNewTrackingNumber(e.target.value)}
											readOnly={isResolvingLink || isSubmitting}
										/>
									</div>
									<div className="form-group" style={{ flex: 1 }}>
										<label className="label">Order Number</label>
										<input
											type="text"
											className="input"
											placeholder={isResolvingLink ? "Loading order ID..." : "e.g. 305-1827771-7197161"}
											value={newOrderNumber}
											onChange={(e) => setNewOrderNumber(e.target.value)}
											readOnly={isResolvingLink || isSubmitting}
										/>
									</div>
								</div>
								<div className="form-group">
									<label className="label">Description / Custom Name (Optional)</label>
									<input
										type="text"
										className="input"
										placeholder={isResolvingLink ? "Loading item description..." : "e.g. New Shoes"}
										value={newName}
										onChange={(e) => setNewName(e.target.value)}
										readOnly={isResolvingLink || isSubmitting}
									/>
								</div>
								<div className="form-group">
									<label className="label">Courier / Source (Optional)</label>
									<input
										type="text"
										className="input"
										placeholder="e.g. Amazon, DHL"
										value={newCourier}
										onChange={(e) => setNewCourier(e.target.value)}
										readOnly={isResolvingLink || isSubmitting}
									/>
								</div>
							</div>
							<div className="modal-footer">
								<button
									type="button"
									className="btn"
									onClick={() => setIsAddModalOpen(false)}
									disabled={isSubmitting || isResolvingLink}
								>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary" disabled={isSubmitting || isResolvingLink}>
									{isSubmitting
										? submitSeconds > 3
											? `Adding (Queued/Rate-Limited ${submitSeconds}s)...`
											: "Adding..."
										: "Add"}
								</button>
							</div>
						</form>
					</div>
				</div>
			)}
		</>
	);
}

export default App;
