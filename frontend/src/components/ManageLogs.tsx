/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
import type React from "react";
import { useEffect, useState } from "react";

interface ServerLog {
	timestamp: string;
	level: string;
	message: string;
}

interface Props {
	token: string;
}

export const ManageLogs: React.FC<Props> = ({ token }) => {
	const [logs, setLogs] = useState<ServerLog[]>([]);

	useEffect(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const wsUrl = `${protocol}//${window.location.host}/api/v1/ws?token=${token}`;
		console.log("[Logs-WS] Connecting to WebSocket logs stream:", wsUrl);
		const ws = new WebSocket(wsUrl);

		ws.onopen = () => {
			console.log("[Logs-WS] WebSocket established. Subscribing to logs...");
			ws.send(JSON.stringify({ action: "subscribe", topic: "logs" }));
		};

		ws.onmessage = (event) => {
			try {
				const payload = JSON.parse(event.data);
				if (payload.event === "log_message" && payload.topic === "logs") {
					setLogs((prev) => [...prev.slice(-499), payload.data]); // Keep last 500 logs
				}
			} catch (err) {
				console.error("[Logs-WS] Error parsing message:", err);
			}
		};

		ws.onerror = (err) => {
			console.error("[Logs-WS] WebSocket error:", err);
		};

		ws.onclose = () => {
			console.log("[Logs-WS] WebSocket connection closed.");
		};

		return () => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ action: "unsubscribe", topic: "logs" }));
			}
			ws.close();
		};
	}, [token]);

	return (
		<div
			className="glass-panel"
			style={{
				padding: "24px",
				display: "flex",
				flexDirection: "column",
				height: "calc(100vh - 200px)",
				minHeight: "500px",
			}}
		>
			<div
				className="panel-header-actions"
				style={{
					marginBottom: "16px",
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
				}}
			>
				<h3 className="panel-title" style={{ margin: 0 }}>
					Real-Time Server Logs
				</h3>
				<div style={{ display: "flex", gap: "8px" }}>
					<button
						className="btn btn-secondary btn-sm"
						onClick={() => {
							const text = logs
								.map(
									(l) =>
										`[${new Date(l.timestamp).toLocaleString()}] [${l.level.toUpperCase()}] ${l.message}`,
								)
								.join("\n");
							navigator.clipboard.writeText(text);
							alert("Logs copied to clipboard!");
						}}
						disabled={logs.length === 0}
					>
						Copy Logs
					</button>
					<button
						className="btn btn-secondary btn-sm text-red"
						onClick={() => setLogs([])}
						disabled={logs.length === 0}
					>
						Clear
					</button>
				</div>
			</div>

			<div
				style={{
					flex: 1,
					background: "rgba(0,0,0,0.6)",
					border: "1px solid rgba(255,255,255,0.05)",
					borderRadius: "8px",
					padding: "16px",
					fontFamily: "'Fira Code', 'Courier New', monospace",
					fontSize: "13px",
					lineHeight: "1.6",
					overflowY: "auto",
					display: "flex",
					flexDirection: "column",
					gap: "6px",
					color: "#e2e8f0",
				}}
				ref={(el) => {
					if (el) el.scrollTop = el.scrollHeight;
				}}
			>
				{logs.length === 0 && (
					<div
						className="text-muted"
						style={{ textAlign: "center", padding: "64px" }}
					>
						Waiting for live server logs... Perform some actions like refreshing
						tracking or changing settings.
					</div>
				)}
				{logs.map((log, i) => {
					let color = "#10b981"; // info: emerald green
					if (log.level === "warn") color = "#f59e0b"; // warn: amber
					if (log.level === "error") color = "#ef4444"; // error: red

					return (
						<div
							key={i}
							style={{
								display: "flex",
								gap: "12px",
								borderBottom: "1px solid rgba(255,255,255,0.02)",
								paddingBottom: "4px",
							}}
						>
							<span
								style={{ color: "rgba(255,255,255,0.3)", minWidth: "120px" }}
							>
								{log.timestamp && !isNaN(new Date(log.timestamp).getTime())
									? new Date(log.timestamp).toLocaleTimeString()
									: new Date().toLocaleTimeString()}
							</span>
							<span
								style={{ color, fontWeight: "bold", minWidth: "60px" }}
							>
								[{log.level.toUpperCase()}]
							</span>
							<span
								style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}
							>
								{log.message}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
};
