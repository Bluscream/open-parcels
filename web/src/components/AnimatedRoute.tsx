import L from "leaflet";
import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
// @ts-ignore - no types available
import { antPath } from "leaflet-ant-path";

interface AnimatedRouteProps {
	positions: [number, number][];
	color?: string;
	dashArray?: string;
}

export const AnimatedRoute: React.FC<AnimatedRouteProps> = ({
	positions,
	color = "#a78bfa",
	dashArray = "10, 20"
}) => {
	const map = useMap();
	const pathRef = useRef<any>(null);

	useEffect(() => {
		if (!positions || positions.length === 0) return;

		// Clean up previous path if it exists
		if (pathRef.current) {
			map.removeLayer(pathRef.current);
		}

		const parsedDashArray = typeof dashArray === 'string' ? dashArray.split(',').map(Number) : dashArray;
		const isSolid = parsedDashArray.length >= 2 && parsedDashArray[0] === 0 && parsedDashArray[1] === 0;

		// Create new ant path
		pathRef.current = antPath(positions, {
			use: L.polyline,
			delay: 600,
			dashArray: parsedDashArray,
			weight: 4,
			color: isSolid ? color : "rgba(0,0,0,0)",
			pulseColor: color,
			paused: isSolid,
			reverse: false,
			hardwareAccelerated: true
		});

		pathRef.current.addTo(map);

		return () => {
			if (pathRef.current) {
				map.removeLayer(pathRef.current);
			}
		};
	}, [positions, color, map]);

	return null;
};
