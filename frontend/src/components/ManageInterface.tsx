/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
/* biome-ignore-all lint/correctness/useExhaustiveDependencies: disable exhaustive dependencies check */
import {
	ArrowLeft,
	Key,
	LayoutDashboard,
	Settings,
	ShieldAlert,
	Terminal,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { ManageCredentials } from "./ManageCredentials";
import { ManageLogs } from "./ManageLogs";
import { ManageOverview } from "./ManageOverview";
import { ManageSettings } from "./ManageSettings";

interface CredentialService {
	id: number;
	service: string;
	updatedAt: string;
}

type Tab = "overview" | "credentials" | "settings" | "logs";

const getTabFromPath = (path: string): Tab => {
	if (path.startsWith("/manage/credentials")) return "credentials";
	if (path.startsWith("/manage/settings")) return "settings";
	if (path.startsWith("/manage/logs")) return "logs";
	return "overview";
};

export const ManageInterface: React.FC = () => {
	const [token, setToken] = useState<string>(() => {
		const urlParams = new URLSearchParams(window.location.search);
		const urlToken = urlParams.get("token");
		const storedToken = localStorage.getItem("openparcels_admin_token");
		if (urlToken) {
			localStorage.setItem("openparcels_admin_token", urlToken);
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
	const [activeTab, setActiveTab] = useState<Tab>(() =>
		getTabFromPath(window.location.pathname),
	);

	const handleTabChange = (tab: Tab) => {
		setActiveTab(tab);
		const newPath =
			tab === "overview" ? "/manage" : `/manage/${tab}`;
		window.history.pushState({}, "", newPath);
		window.dispatchEvent(new Event("popstate"));
	};

	useEffect(() => {
		const handleLocationChange = () => {
			setActiveTab(getTabFromPath(window.location.pathname));
		};
		window.addEventListener("popstate", handleLocationChange);
		return () => window.removeEventListener("popstate", handleLocationChange);
	}, []);

	// Settings form state lifted here so it persists across tab switches
	const [settingsForm, setSettingsForm] = useState({
		timezone: "",
		home_name: "",
		home_latitude: "",
		home_longitude: "",
	});

	const [credentialsList, setCredentialsList] = useState<CredentialService[]>(
		[],
	);

	const fetchData = useCallback(async () => {
		try {
			const resC = await fetch(`/api/v1/credentials?token=${token}`);
			if (resC.status === 403 || resC.status === 401) {
				localStorage.removeItem("openparcels_admin_token");
				setShowTokenPrompt(true);
				return;
			}
			if (resC.ok) {
				setCredentialsList(await resC.json());
			}

			const resS = await fetch(`/api/v1/settings?token=${token}`);
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

	// Probe auth requirement when no token stored
	useEffect(() => {
		if (token === "") {
			fetch("/api/v1/parcels")
				.then((res) => {
					setShowTokenPrompt(res.status !== 200);
				})
				.catch(() => setShowTokenPrompt(true));
		}
	}, [token]);

	useEffect(() => {
		if (!token && showTokenPrompt) return;
		const timer = setTimeout(() => fetchData(), 0);
		return () => clearTimeout(timer);
	}, [token, fetchData, showTokenPrompt]);

	const handleTokenSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!tokenInput) return;
		localStorage.setItem("openparcels_admin_token", tokenInput);
		setToken(tokenInput);
		setShowTokenPrompt(false);
	};

	const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
		{ id: "overview", label: "Overview", icon: <LayoutDashboard size={16} /> },
		{ id: "credentials", label: "Credentials", icon: <Key size={16} /> },
		{ id: "settings", label: "Settings", icon: <Settings size={16} /> },
		{ id: "logs", label: "Logs", icon: <Terminal size={16} /> },
	];

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
							Authentication Required
						</h3>
						<p
							className="text-muted"
							style={{ textAlign: "center", fontSize: "14px" }}
						>
							Please enter your <code>OPENPARCELS_TOKEN</code> token to access
							the management panel.
						</p>
						<form onSubmit={handleTokenSubmit}>
							<div className="form-group">
								<input
									type="password"
									className="input"
									placeholder="Enter access token..."
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

			{/* Main Manage UI */}
			{!showTokenPrompt && (
				<>
					<div className="manage-header">
						<div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
							<a href="/" className="btn-icon">
								<ArrowLeft size={20} />
							</a>
							<h2 style={{ margin: 0 }}>Management Console</h2>
						</div>

						<div className="manage-tabs glass-panel">
							{TABS.map((tab) => (
								<button
									key={tab.id}
									className={`manage-tab ${activeTab === tab.id ? "active" : ""}`}
									onClick={() => handleTabChange(tab.id)}
								>
									{tab.icon}
									<span>{tab.label}</span>
								</button>
							))}
						</div>
					</div>

					<div className="manage-content">
						{activeTab === "overview" && (
							<ManageOverview token={token} onRefresh={fetchData} />
						)}

						{activeTab === "credentials" && (
							<ManageCredentials
								token={token}
								credentialsList={credentialsList}
								onRefresh={fetchData}
							/>
						)}

						{activeTab === "settings" && (
							<ManageSettings
								token={token}
								settingsForm={settingsForm}
								setSettingsForm={setSettingsForm}
								onRefresh={fetchData}
							/>
						)}

						{activeTab === "logs" && <ManageLogs token={token} />}
					</div>
				</>
			)}
		</div>
	);
};
