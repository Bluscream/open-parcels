/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
import {
	AlertTriangle,
	Archive,
	CheckCircle,
	Clock,
	Database,
	Download,
	FileQuestion,
	HardDrive,
	Key,
	Package,
	RefreshCw,
	RotateCcw,
	ShoppingBag,
	Trash2,
	Truck,
	Upload,
	Zap,
	Mail,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

interface StatusData {
	uptime: number;
	parcels: number;
	orders: number;
	credentials: number;
	events: number;
	parcelsByStatus: { status: string; count: number }[];
	ordersByStatus: { status: string; count: number }[];
	dbSizeBytes: number;
	nodeVersion: string;
	env: string;
}

interface Props {
	token: string;
	onRefresh: () => void;
}

function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86400);
	const h = Math.floor((seconds % 86400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (d > 0) return `${d}d ${h}h ${m}m`;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const STATUS_ICON: Record<string, React.ReactNode> = {
	ordered: <ShoppingBag size={13} />,
	placed: <ShoppingBag size={13} />,
	confirmed: <ShoppingBag size={13} />,
	sent: <Truck size={13} />,
	shipped: <Truck size={13} />,
	arriving: <Zap size={13} />,
	delivered: <CheckCircle size={13} />,
	"return-sent": <RotateCcw size={13} />,
	"return-accepted": <Archive size={13} />,
	unknown: <FileQuestion size={13} />,
};

const STATUS_COLOR: Record<string, string> = {
	ordered: "#818cf8",
	placed: "#818cf8",
	confirmed: "#818cf8",
	sent: "#60a5fa",
	shipped: "#60a5fa",
	arriving: "#f59e0b",
	delivered: "#10b981",
	"return-sent": "#f97316",
	"return-accepted": "#a78bfa",
	unknown: "rgba(255,255,255,0.4)",
};

export const ManageOverview: React.FC<Props> = ({ token, onRefresh }) => {
	const [status, setStatus] = useState<StatusData | null>(null);
	const [loading, setLoading] = useState(true);
	const [restoreMsg, setRestoreMsg] = useState<string | null>(null);
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const [clearing, setClearing] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const emailInputRef = useRef<HTMLInputElement>(null);
	const [ingestMsg, setIngestMsg] = useState<string | null>(null);
	const [ingestError, setIngestError] = useState<string | null>(null);
	const [ingesting, setIngesting] = useState(false);

	const handleIngestClick = () => emailInputRef.current?.click();

	const handleIngestFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;

		const form = new FormData();
		form.append("file", file);
		setIngesting(true);
		setIngestMsg(null);
		setIngestError(null);

		try {
			const res = await fetch(`/api/v1/admin/ingest-emails?token=${token}`, {
				method: "POST",
				body: form,
			});
			const data = await res.json();
			if (res.ok) {
				setIngestMsg(`${data.message} Created ${data.orderCount} new order(s) and ${data.parcelCount} new parcel(s).`);
				fetchStatus();
				onRefresh();
			} else {
				setIngestError(data.error || "Ingestion failed");
			}
		} catch (err) {
			setIngestError("Network error during email ingestion");
		} finally {
			setIngesting(false);
		}
		e.target.value = "";
	};

	const fetchStatus = async () => {
		try {
			setRefreshing(true);
			const res = await fetch(`/api/v1/status?token=${token}`);
			if (res.ok) {
				setStatus(await res.json());
			}
		} catch (err) {
			console.error("Failed to fetch status", err);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	};

	useEffect(() => {
		fetchStatus();
		// Auto-refresh every 30s
		const interval = setInterval(fetchStatus, 30_000);
		return () => clearInterval(interval);
	}, [token]);

	const handleBackup = () => {
		window.location.href = `/api/v1/admin/db-backup?token=${token}`;
	};

	const handleRestoreClick = () => fileInputRef.current?.click();

	const handleRestoreFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		if (
			!confirm(
				`⚠️ This will REPLACE the current database with "${file.name}". A safety backup will be created first. Continue?`,
			)
		) {
			e.target.value = "";
			return;
		}
		const form = new FormData();
		form.append("file", file);
		try {
			const res = await fetch(`/api/v1/admin/db-restore?token=${token}`, {
				method: "POST",
				body: form,
			});
			const data = await res.json();
			if (res.ok) {
				setRestoreMsg(data.message);
				setRestoreError(null);
				fetchStatus();
				onRefresh();
			} else {
				setRestoreError(data.error || "Restore failed");
				setRestoreMsg(null);
			}
		} catch (err) {
			setRestoreError("Network error during restore");
		}
		e.target.value = "";
	};

	const handleClear = async () => {
		if (
			!confirm(
				"⚠️ DANGER: This will permanently delete ALL parcels, orders, and credentials from the database. This cannot be undone. Are you absolutely sure?",
			)
		)
			return;
		if (!confirm("Last chance — permanently delete ALL data?")) return;
		try {
			setClearing(true);
			const res = await fetch(`/api/v1/admin/db-clear?token=${token}`, {
				method: "POST",
			});
			if (res.ok) {
				await fetchStatus();
				onRefresh();
			} else {
				const data = await res.json();
				alert(`Failed to clear: ${data.error}`);
			}
		} finally {
			setClearing(false);
		}
	};

	if (loading) {
		return (
			<div
				style={{
					display: "flex",
					justifyContent: "center",
					alignItems: "center",
					height: "300px",
					gap: "12px",
					color: "var(--text-muted)",
				}}
			>
				<RefreshCw size={20} className="spin" />
				<span>Loading overview...</span>
			</div>
		);
	}

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
			{/* Alerts */}
			{restoreMsg && (
				<div
					style={{
						background: "rgba(16,185,129,0.12)",
						border: "1px solid rgba(16,185,129,0.3)",
						borderRadius: "10px",
						padding: "12px 16px",
						display: "flex",
						alignItems: "center",
						gap: "10px",
						color: "#10b981",
					}}
				>
					<CheckCircle size={16} />
					<span style={{ flex: 1 }}>{restoreMsg}</span>
					<button
						onClick={() => setRestoreMsg(null)}
						style={{
							background: "none",
							border: "none",
							color: "#10b981",
							cursor: "pointer",
						}}
					>
						✕
					</button>
				</div>
			)}
			{restoreError && (
				<div
					style={{
						background: "rgba(239,68,68,0.12)",
						border: "1px solid rgba(239,68,68,0.3)",
						borderRadius: "10px",
						padding: "12px 16px",
						display: "flex",
						alignItems: "center",
						gap: "10px",
						color: "#ef4444",
					}}
				>
					<AlertTriangle size={16} />
					<span style={{ flex: 1 }}>{restoreError}</span>
					<button
						onClick={() => setRestoreError(null)}
						style={{
							background: "none",
							border: "none",
							color: "#ef4444",
							cursor: "pointer",
						}}
					>
						✕
					</button>
				</div>
			)}
			{ingestMsg && (
				<div
					style={{
						background: "rgba(16,185,129,0.12)",
						border: "1px solid rgba(16,185,129,0.3)",
						borderRadius: "10px",
						padding: "12px 16px",
						display: "flex",
						alignItems: "center",
						gap: "10px",
						color: "#10b981",
					}}
				>
					<CheckCircle size={16} />
					<span style={{ flex: 1 }}>{ingestMsg}</span>
					<button
						onClick={() => setIngestMsg(null)}
						style={{
							background: "none",
							border: "none",
							color: "#10b981",
							cursor: "pointer",
						}}
					>
						✕
					</button>
				</div>
			)}
			{ingestError && (
				<div
					style={{
						background: "rgba(239,68,68,0.12)",
						border: "1px solid rgba(239,68,68,0.3)",
						borderRadius: "10px",
						padding: "12px 16px",
						display: "flex",
						alignItems: "center",
						gap: "10px",
						color: "#ef4444",
					}}
				>
					<AlertTriangle size={16} />
					<span style={{ flex: 1 }}>{ingestError}</span>
					<button
						onClick={() => setIngestError(null)}
						style={{
							background: "none",
							border: "none",
							color: "#ef4444",
							cursor: "pointer",
						}}
					>
						✕
					</button>
				</div>
			)}

			{/* Top row — key stats */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
					gap: "14px",
				}}
			>
				{[
					{
						label: "Parcels",
						value: status?.parcels ?? "—",
						icon: <Package size={22} />,
						color: "#818cf8",
					},
					{
						label: "Orders",
						value: status?.orders ?? "—",
						icon: <ShoppingBag size={22} />,
						color: "#60a5fa",
					},
					{
						label: "Tracking Events",
						value: status?.events ?? "—",
						icon: <Zap size={22} />,
						color: "#f59e0b",
					},
					{
						label: "Credentials",
						value: status?.credentials ?? "—",
						icon: <Key size={22} />,
						color: "#f97316",
					},
					{
						label: "Uptime",
						value: status ? formatUptime(status.uptime) : "—",
						icon: <Clock size={22} />,
						color: "#10b981",
					},
					{
						label: "DB Size",
						value: status ? formatBytes(status.dbSizeBytes) : "—",
						icon: <HardDrive size={22} />,
						color: "#a78bfa",
					},
				].map((stat) => (
					<div
						key={stat.label}
						className="glass-panel"
						style={{
							padding: "18px 20px",
							display: "flex",
							flexDirection: "column",
							gap: "10px",
							position: "relative",
							overflow: "hidden",
						}}
					>
						<div
							style={{
								position: "absolute",
								top: "-10px",
								right: "-10px",
								opacity: 0.06,
								color: stat.color,
								fontSize: "80px",
								lineHeight: 1,
								pointerEvents: "none",
							}}
						>
							{stat.icon}
						</div>
						<div style={{ color: stat.color, opacity: 0.85 }}>{stat.icon}</div>
						<div
							style={{
								fontSize: "28px",
								fontWeight: 700,
								lineHeight: 1,
								color: "#fff",
							}}
						>
							{stat.value}
						</div>
						<div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
							{stat.label}
						</div>
					</div>
				))}
			</div>

			{/* Middle row — status breakdown + system info */}
			<div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
				{/* Left Column: Status Breakdowns */}
				<div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
					{/* Parcels by Status */}
					<div className="glass-panel" style={{ padding: "20px" }}>
						<h4
							style={{
								margin: "0 0 16px 0",
								fontSize: "13px",
								fontWeight: 600,
								color: "var(--text-muted)",
								textTransform: "uppercase",
								letterSpacing: "0.06em",
							}}
						>
							Parcels by Status
						</h4>
						{status?.parcelsByStatus && status.parcelsByStatus.length > 0 ? (
							<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
								{status.parcelsByStatus.map((row) => {
									const pct =
										status.parcels > 0
											? Math.round((row.count / status.parcels) * 100)
											: 0;
									const col =
										STATUS_COLOR[row.status] || "rgba(255,255,255,0.4)";
									return (
										<div key={row.status}>
											<div
												style={{
													display: "flex",
													justifyContent: "space-between",
													alignItems: "center",
													marginBottom: "4px",
												}}
											>
												<div
													style={{
														display: "flex",
														alignItems: "center",
														gap: "6px",
														color: col,
														fontSize: "13px",
													}}
												>
													{STATUS_ICON[row.status] || (
														<FileQuestion size={13} />
													)}
													<span style={{ textTransform: "capitalize" }}>
														{row.status}
													</span>
												</div>
												<span
													style={{
														fontSize: "13px",
														fontWeight: 600,
														color: "#fff",
													}}
												>
													{row.count}
													<span
														style={{
															color: "var(--text-muted)",
															fontWeight: 400,
															marginLeft: "4px",
														}}
													>
														({pct}%)
													</span>
												</span>
											</div>
											<div
												style={{
													height: "4px",
													background: "rgba(255,255,255,0.06)",
													borderRadius: "99px",
													overflow: "hidden",
												}}
											>
												<div
													style={{
														height: "100%",
														width: `${pct}%`,
														background: col,
														borderRadius: "99px",
														transition: "width 0.5s ease",
													}}
												/>
											</div>
										</div>
									);
								})}
							</div>
						) : (
							<p className="text-muted" style={{ fontSize: "13px" }}>
								No parcels yet.
							</p>
						)}
					</div>

					{/* Orders by Status */}
					<div className="glass-panel" style={{ padding: "20px" }}>
						<h4
							style={{
								margin: "0 0 16px 0",
								fontSize: "13px",
								fontWeight: 600,
								color: "var(--text-muted)",
								textTransform: "uppercase",
								letterSpacing: "0.06em",
							}}
						>
							Orders by Status
						</h4>
						{status?.ordersByStatus && status.ordersByStatus.length > 0 ? (
							<div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
								{status.ordersByStatus.map((row) => {
									const pct =
										status.orders > 0
											? Math.round((row.count / status.orders) * 100)
											: 0;
									const col =
										STATUS_COLOR[row.status] || "rgba(255,255,255,0.4)";
									return (
										<div key={row.status}>
											<div
												style={{
													display: "flex",
													justifyContent: "space-between",
													alignItems: "center",
													marginBottom: "4px",
												}}
											>
												<div
													style={{
														display: "flex",
														alignItems: "center",
														gap: "6px",
														color: col,
														fontSize: "13px",
													}}
												>
													{STATUS_ICON[row.status] || (
														<FileQuestion size={13} />
													)}
													<span style={{ textTransform: "capitalize" }}>
														{row.status}
													</span>
												</div>
												<span
													style={{
														fontSize: "13px",
														fontWeight: 600,
														color: "#fff",
													}}
												>
													{row.count}
													<span
														style={{
															color: "var(--text-muted)",
															fontWeight: 400,
															marginLeft: "4px",
														}}
													>
														({pct}%)
													</span>
												</span>
											</div>
											<div
												style={{
													height: "4px",
													background: "rgba(255,255,255,0.06)",
													borderRadius: "99px",
													overflow: "hidden",
												}}
											>
												<div
													style={{
														height: "100%",
														width: `${pct}%`,
														background: col,
														borderRadius: "99px",
														transition: "width 0.5s ease",
													}}
												/>
											</div>
										</div>
									);
								})}
							</div>
						) : (
							<p className="text-muted" style={{ fontSize: "13px" }}>
								No orders yet.
							</p>
						)}
					</div>
				</div>

				{/* System Info */}
				<div className="glass-panel" style={{ padding: "20px" }}>
					<h4
						style={{
							margin: "0 0 16px 0",
							fontSize: "13px",
							fontWeight: 600,
							color: "var(--text-muted)",
							textTransform: "uppercase",
							letterSpacing: "0.06em",
						}}
					>
						System Info
					</h4>
					<div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
						{[
							{ label: "Node.js", value: status?.nodeVersion ?? "—" },
							{ label: "Environment", value: status?.env ?? "—" },
							{
								label: "DB File Size",
								value: status ? formatBytes(status.dbSizeBytes) : "—",
							},
							{
								label: "Server Uptime",
								value: status ? formatUptime(status.uptime) : "—",
							},
						].map((row) => (
							<div
								key={row.label}
								style={{
									display: "flex",
									justifyContent: "space-between",
									alignItems: "center",
									padding: "8px 0",
									borderBottom: "1px solid rgba(255,255,255,0.04)",
								}}
							>
								<span
									style={{ fontSize: "13px", color: "var(--text-muted)" }}
								>
									{row.label}
								</span>
								<span
									style={{
										fontSize: "13px",
										fontWeight: 600,
										color: "#e2e8f0",
										fontFamily: "'Fira Code', monospace",
									}}
								>
									{row.value}
								</span>
							</div>
						))}
					</div>

					<button
						onClick={() => fetchStatus()}
						disabled={refreshing}
						className="btn btn-secondary btn-sm"
						style={{ marginTop: "16px", width: "100%", gap: "6px" }}
					>
						<RefreshCw
							size={13}
							style={{
								animation: refreshing ? "spin 1s linear infinite" : "none",
							}}
						/>
						{refreshing ? "Refreshing…" : "Refresh Stats"}
					</button>
				</div>
			</div>

			{/* Email Ingestion */}
			<div className="glass-panel" style={{ padding: "20px" }}>
				<h4
					style={{
						margin: "0 0 16px 0",
						fontSize: "13px",
						fontWeight: 600,
						color: "var(--text-muted)",
						textTransform: "uppercase",
						letterSpacing: "0.06em",
					}}
				>
					Email Ingestion
				</h4>
				<div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
					<button
						onClick={handleIngestClick}
						disabled={ingesting}
						className="btn btn-primary"
						style={{ gap: "8px" }}
					>
						<Mail size={15} />
						{ingesting ? "Uploading & Ingesting…" : "Upload Email(s)"}
					</button>
					<input
						ref={emailInputRef}
						type="file"
						accept=".eml,.zip"
						style={{ display: "none" }}
						onChange={handleIngestFile}
					/>
				</div>
				<p
					className="text-muted"
					style={{ marginTop: "12px", fontSize: "12px" }}
				>
					<Mail size={11} style={{ marginRight: "4px" }} />
					Upload a single <code>.eml</code> file or a <code>.zip</code> archive containing multiple <code>.eml</code> files.
					The system will scan them for order information and tracking numbers to automatically ingest.
				</p>
			</div>

			{/* Database Actions */}
			<div className="glass-panel" style={{ padding: "20px" }}>
				<h4
					style={{
						margin: "0 0 16px 0",
						fontSize: "13px",
						fontWeight: 600,
						color: "var(--text-muted)",
						textTransform: "uppercase",
						letterSpacing: "0.06em",
					}}
				>
					Database Actions
				</h4>
				<div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
					{/* Backup */}
					<button
						onClick={handleBackup}
						className="btn btn-secondary"
						style={{ gap: "8px" }}
					>
						<Download size={15} />
						Download Backup
					</button>

					{/* Restore */}
					<button
						onClick={handleRestoreClick}
						className="btn btn-secondary"
						style={{ gap: "8px" }}
					>
						<Upload size={15} />
						Restore from Backup
					</button>
					<input
						ref={fileInputRef}
						type="file"
						accept=".sql,text/plain"
						style={{ display: "none" }}
						onChange={handleRestoreFile}
					/>

					{/* Clear */}
					<button
						onClick={handleClear}
						disabled={clearing}
						className="btn"
						style={{
							gap: "8px",
							marginLeft: "auto",
							background: "rgba(239,68,68,0.12)",
							border: "1px solid rgba(239,68,68,0.3)",
							color: "#ef4444",
						}}
					>
						<Trash2 size={15} />
						{clearing ? "Clearing…" : "Clear All Data"}
					</button>
				</div>
				<p
					className="text-muted"
					style={{ marginTop: "12px", fontSize: "12px" }}
				>
					<Database size={11} style={{ marginRight: "4px" }} />
					Backup downloads a portable <code>.sql</code> text dump. Restore imports a
					<code>.sql</code> dump (a safety copy of the raw DB file is created
					automatically first). Clear wipes all parcels, orders, and credentials
					permanently.
				</p>
			</div>
		</div>
	);
};
