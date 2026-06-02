/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any for dynamic props/components */
/* biome-ignore-all lint/a11y: disable a11y rules for frontend prototype */
/* biome-ignore-all lint/correctness/useExhaustiveDependencies: disable exhaustive dependencies check */
import L from "leaflet";
import type React from "react";
import { useState } from "react";
import {
	MapContainer,
	Marker,
	TileLayer,
	useMap,
	useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import { useEffect } from "react";

delete (L.Icon.Default.prototype as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
	iconUrl: markerIcon,
	iconRetinaUrl: markerIcon2x,
	shadowUrl: markerShadow,
});

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

interface SettingsForm {
	timezone: string;
	home_name: string;
	home_latitude: string;
	home_longitude: string;
}

interface Props {
	token: string;
	settingsForm: SettingsForm;
	setSettingsForm: (form: SettingsForm) => void;
	onRefresh: () => void;
}

export const ManageSettings: React.FC<Props> = ({
	token,
	settingsForm,
	setSettingsForm,
	onRefresh,
}) => {
	const [searchQuery, setSearchQuery] = useState("");
	const [searchingLocation, setSearchingLocation] = useState(false);

	const saveSettings = async (e: React.FormEvent) => {
		e.preventDefault();
		try {
			const res = await fetch(`/api/v1/settings?token=${token}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					timezone: settingsForm.timezone,
					home_name: settingsForm.home_name,
					home_latitude: parseFloat(settingsForm.home_latitude),
					home_longitude: parseFloat(settingsForm.home_longitude),
				}),
			});
			if (res.ok) {
				alert("Settings saved successfully!");
				onRefresh();
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
					Click anywhere on the map below to instantly select it as your home
					destination location.
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
							!Number.isNaN(parseFloat(settingsForm.home_longitude)) && (
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
	);
};
