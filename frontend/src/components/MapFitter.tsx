import L from "leaflet";
import { useEffect } from "react";
import { useMap } from "react-leaflet";

interface MapFitterProps {
	bounds?: [number, number][];
}

export const MapFitter: React.FC<MapFitterProps> = ({ bounds }) => {
	const map = useMap();

	useEffect(() => {
		if (bounds && bounds.length > 0) {
			try {
				// Filter out any NaN coordinates
				const validBounds = bounds.filter(
					(b) =>
						!Number.isNaN(b[0]) &&
						!Number.isNaN(b[1]) &&
						b[0] !== undefined &&
						b[1] !== undefined
				);

				if (validBounds.length > 0) {
					const leafletBounds = L.latLngBounds(validBounds);
					map.fitBounds(leafletBounds, { padding: [50, 50], maxZoom: 12 });
				}
			} catch (e) {
				console.error("Failed to fit bounds", e);
			}
		}
	}, [bounds, map]);

	return null;
};
