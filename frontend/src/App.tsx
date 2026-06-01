/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
import { Package, Shield } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { ManageInterface } from "./components/ManageInterface";
import { MapDashboard } from "./components/MapDashboard";
import { ParcelDetail } from "./components/ParcelDetail";
import { getGuestToken } from "./utils/auth";
import "./index.css";

interface ToastInfo {
	id: number;
	title: string;
	message: string;
	trackingNumber: string;
}

function App() {
	const [currentPath, setCurrentPath] = useState(window.location.pathname);
	const [toasts, setToasts] = useState<ToastInfo[]>([]);

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

	const isManage = currentPath.startsWith("/manage");
	const parcelMatch = currentPath.match(/^\/parcel\/([^/]+)\/?$/);
	const selectedTrackingNumber = parcelMatch ? parcelMatch[1] : null;

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
					<div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
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
							<span>Admin Console</span>
						</a>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: "8px",
								color: "var(--text-muted)",
							}}
						>
							<Package size={20} />
							<span>v1.0.0</span>
						</div>
					</div>
				</header>
			)}
			{isManage ? (
				<ManageInterface />
			) : selectedTrackingNumber ? (
				<ParcelDetail
					trackingNumber={selectedTrackingNumber}
					onBack={() => navigateTo("/")}
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
		</>
	);
}

export default App;
