import { useEffect, useState, createContext, useContext } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import { Layers } from "lucide-react";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

export interface MapFilters {
	home: boolean;
	destination: boolean;
	source: boolean;
	stops: boolean;
	takenPath: boolean;
	futurePath: boolean;
	parcel: boolean;
}

const DEFAULT_FILTERS: MapFilters = {
	home: true,
	destination: true,
	source: true,
	stops: true,
	takenPath: true,
	futurePath: true,
	parcel: true,
};

export const MapFiltersContext = createContext<{
	filters: MapFilters;
	setFilters: React.Dispatch<React.SetStateAction<MapFilters>>;
}>({
	filters: DEFAULT_FILTERS,
	setFilters: () => {},
});

export function useMapFilters() {
	return useContext(MapFiltersContext);
}

interface SharedMapProps {
	bounds?: [number, number][];
	center?: [number, number];
	zoom?: number;
	children?: React.ReactNode;
}

function MapResizer({ bounds }: { bounds?: [number, number][] }) {
	const map = useMap();
	
	useEffect(() => {
		const fitMapBounds = () => {
			if (!bounds || bounds.length === 0) return;
			const validBounds = bounds.filter(
				(b) =>
					!Number.isNaN(b[0]) &&
					!Number.isNaN(b[1]) &&
					b[0] !== undefined &&
					b[1] !== undefined
			);
			if (validBounds.length > 0) {
				map.fitBounds(L.latLngBounds(validBounds), { padding: [50, 50], maxZoom: 12 });
			}
		};

		const resizeObserver = new ResizeObserver(() => {
			map.invalidateSize();
			setTimeout(fitMapBounds, 10);
		});
		
		const container = map.getContainer();
		resizeObserver.observe(container);
		
		fitMapBounds();
		
		return () => {
			resizeObserver.unobserve(container);
			resizeObserver.disconnect();
		};
	}, [map, bounds]);
	
	return null;
}

function FloatingLegend() {
	const { filters, setFilters } = useContext(MapFiltersContext);
	const [isOpen, setIsOpen] = useState(false);

	const handleToggle = (key: keyof MapFilters) => {
		setFilters((prev) => {
			const nextValue = !prev[key];
			if (key === "home") {
				return {
					...prev,
					home: nextValue,
					destination: nextValue,
				};
			}
			return {
				...prev,
				[key]: nextValue,
			};
		});
	};

	const filterConfig: { key: keyof MapFilters; label: string }[] = [
		{ key: "home", label: "Home" },
		{ key: "source", label: "Source" },
		{ key: "stops", label: "Stops" },
		{ key: "takenPath", label: "Taken Path" },
		{ key: "futurePath", label: "Future Path" },
		{ key: "parcel", label: "Parcel" },
	];

	return (
		<div
			style={{
				position: "absolute",
				top: "10px",
				right: "10px",
				pointerEvents: "auto",
				zIndex: 9999,
				fontFamily: "var(--font-sans, system-ui, sans-serif)",
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<div
				style={{
					background: "rgba(15, 23, 42, 0.85)",
					backdropFilter: "blur(12px)",
					border: "1px solid rgba(255, 255, 255, 0.1)",
					borderRadius: "8px",
					boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.5)",
					color: "#f8fafc",
					overflow: "hidden",
					transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
					width: isOpen ? "200px" : "36px",
					height: isOpen ? "auto" : "36px",
					maxHeight: isOpen ? "300px" : "36px",
				}}
			>
				{/* Header Toggle Button */}
				<button
					type="button"
					onClick={() => setIsOpen(!isOpen)}
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: isOpen ? "space-between" : "center",
						width: "100%",
						height: "36px",
						padding: isOpen ? "0 12px" : "0",
						background: "transparent",
						border: "none",
						color: "#f8fafc",
						cursor: "pointer",
						fontWeight: 600,
						fontSize: "13px",
						outline: "none",
					}}
				>
					{isOpen && <span style={{ letterSpacing: "0.5px" }}>MAP LEGEND</span>}
					<Layers size={16} style={{ opacity: isOpen ? 0.8 : 1 }} />
				</button>

				{/* Expandable Panel */}
				{isOpen && (
					<div
						style={{
							padding: "6px 12px 12px 12px",
							borderTop: "1px solid rgba(255, 255, 255, 0.08)",
							display: "flex",
							flexDirection: "column",
							gap: "8px",
						}}
					>
						{filterConfig.map(({ key, label }) => (
							<label
								key={key}
								style={{
									display: "flex",
									alignItems: "center",
									gap: "8px",
									fontSize: "12px",
									cursor: "pointer",
									userSelect: "none",
									padding: "4px 0",
									transition: "opacity 0.15s ease",
									opacity: filters[key] ? 1 : 0.5,
								}}
							>
								<input
									type="checkbox"
									checked={filters[key]}
									onChange={() => handleToggle(key)}
									style={{
										accentColor: "#a78bfa",
										width: "14px",
										height: "14px",
										cursor: "pointer",
									}}
								/>
								<span style={{ fontWeight: 500 }}>{label}</span>
							</label>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export const SharedMap: React.FC<SharedMapProps> = ({
	bounds,
	center = [0, 0],
	zoom = 3,
	children
}) => {
	const [filters, setFilters] = useState<MapFilters>(() => {
		const saved = localStorage.getItem("map_filters");
		if (saved) {
			try {
				return { ...DEFAULT_FILTERS, ...JSON.parse(saved) };
			} catch (_) {}
		}
		return DEFAULT_FILTERS;
	});

	useEffect(() => {
		localStorage.setItem("map_filters", JSON.stringify(filters));
	}, [filters]);

	return (
		<MapFiltersContext.Provider value={{ filters, setFilters }}>
			<div style={{ height: "100%", width: "100%", position: "relative" }}>
				<MapContainer
					center={center}
					zoom={zoom}
					scrollWheelZoom={true}
					style={{ height: "100%", width: "100%", borderRadius: "12px", zIndex: 0 }}
				>
					<MapResizer bounds={bounds} />
					<TileLayer
						attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
						url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
					/>
					{children}
				</MapContainer>
				<FloatingLegend />
			</div>
		</MapFiltersContext.Provider>
	);
};
