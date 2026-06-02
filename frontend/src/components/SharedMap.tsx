import { useEffect } from "react";
import { MapContainer, TileLayer, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

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
			// Re-fit bounds after size is updated
			setTimeout(fitMapBounds, 10);
		});
		
		const container = map.getContainer();
		resizeObserver.observe(container);
		
		// Initial fit
		fitMapBounds();
		
		return () => {
			resizeObserver.unobserve(container);
			resizeObserver.disconnect();
		};
	}, [map, bounds]);
	
	return null;
}

export const SharedMap: React.FC<SharedMapProps> = ({
	bounds,
	center = [0, 0],
	zoom = 3,
	children
}) => {
	return (
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
	);
};
