import { Home, Package, Plane, Ship, Train, Truck, MapPin, Helicopter, Van, Bike } from "lucide-react";
import React from "react";
import { renderToString } from "react-dom/server";
import L from "leaflet";

export const createDivIcon = (
	iconNode: React.ReactNode,
	color: string,
	containerSize = 32
) => {
	const html = renderToString(
		<div
			style={{
				color,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: `${containerSize}px`,
				height: `${containerSize}px`,
				boxSizing: "border-box",
				filter: `drop-shadow(0px 2px 4px rgba(0,0,0,0.6))`,
			}}
		>
			{iconNode}
		</div>
	);
	return L.divIcon({
		html,
		className: "custom-leaflet-icon",
		iconSize: [containerSize, containerSize],
		iconAnchor: [containerSize / 2, containerSize / 2],
		popupAnchor: [0, -containerSize / 2],
	});
};

export const iconHome = createDivIcon(<Home size={28} />, "#10b981", 36); // Emerald
export const iconPackage = createDivIcon(<Package size={24} />, "#818cf8", 32); // Indigo
export const iconTruck = createDivIcon(<Truck size={24} />, "#ea580c", 32); // Orange for cargo truck
export const iconVan = createDivIcon(<Van size={24} />, "#f59e0b", 32); // Amber for delivery van
export const iconPlane = createDivIcon(<Plane size={24} />, "#60a5fa", 32); // Blue
export const iconShip = createDivIcon(<Ship size={24} />, "#3b82f6", 32); // Darker Blue
export const iconTrain = createDivIcon(<Train size={24} />, "#a855f7", 32); // Purple
export const iconSource = createDivIcon(<MapPin size={24} />, "#ef4444", 28); // Red
export const iconIntermediate = createDivIcon(<MapPin size={20} />, "#9ca3af", 24); // Gray
export const iconCurrent = createDivIcon(<MapPin size={24} fill="#3b82f6" />, "#3b82f6", 28); // Blue filled
export const iconHeli = createDivIcon(<Helicopter size={24} />, "#06b6d4", 32); // Cyan/Teal
export const iconBike = createDivIcon(<Bike size={24} />, "#22c55e", 32); // Green for bicycle

export function getTransportMarkerIcon(method?: string) {
	switch (method?.toLowerCase()) {
		case "plane":
		case "flight":
			return iconPlane;
		case "ship":
		case "boat":
			return iconShip;
		case "train":
		case "rail":
			return iconTrain;
		case "truck":
			return iconTruck;
		case "van":
			return iconVan;
		case "heli":
		case "helicopter":
			return iconHeli;
		case "bike":
		case "bicycle":
			return iconBike;
		default:
			return iconPackage;
	}
}

export function determineTransportMethod(events: { description?: string; status?: string; timestamp?: string; date?: string }[]): string {
	if (!events || events.length === 0) return "unknown";

	const planeWords = ["plane", "flight", "air", "aircraft", "airplane", "flug", "luft", "flying"];
	const shipWords = ["ship", "boat", "schiff", "boot", "ocean", "sea", "vessel", "container", "port"];
	const heliWords = ["helicopter", "heli", "hubschrauber"];
	const trainWords = ["train", "rail", "bahn", "zug", "railway"];
	const bikeWords = ["bike", "bicycle", "fahrrad", "cycling", "radfahrer"];
	const vanWords = ["van", "delivery vehicle", "zustellfahrzeug", "delivery", "carrier", "courier", "post", "filiale", "outlet"];
	const truckWords = ["truck", "lkw", "hauler", "laster", "freight", "cargo", "transit", "sorting", "road", "vehicle", "fahrzeug"];

	const sortedEventsDesc = [...events].sort((a: any, b: any) => {
		const timeA = a.timestamp ? new Date(a.timestamp).getTime() : (a.date ? new Date(a.date).getTime() : 0);
		const timeB = b.timestamp ? new Date(b.timestamp).getTime() : (b.date ? new Date(b.date).getTime() : 0);
		return timeB - timeA;
	});

	for (const event of sortedEventsDesc) {
		const text = ((event.description || "") + " " + (event.status || "")).toLowerCase();
		
		if (planeWords.some(w => text.includes(w))) return "plane";
		if (shipWords.some(w => text.includes(w))) return "ship";
		if (heliWords.some(w => text.includes(w))) return "heli";
		if (trainWords.some(w => text.includes(w))) return "train";
		if (bikeWords.some(w => text.includes(w))) return "bike";
		if (vanWords.some(w => text.includes(w))) return "van";
		if (truckWords.some(w => text.includes(w))) return "truck";
	}

	return "unknown";
}

// Computes a quadratic Bezier curve between two coordinates
export function getBezierCurve(start: [number, number], end: [number, number], segments = 50): [number, number][] {
	const lat1 = start[0];
	const lng1 = start[1];
	const lat2 = end[0];
	const lng2 = end[1];

	// Control point: mid-point but offset slightly to create a curve
	const midLat = (lat1 + lat2) / 2;
	const midLng = (lng1 + lng2) / 2;
	
	// Offset perpendicular to the line between start and end
	// This is a simple approximation
	const dLat = lat2 - lat1;
	const dLng = lng2 - lng1;
	
	// Distance
	const dist = Math.sqrt(dLat * dLat + dLng * dLng);
	
	// If points are very close, don't curve
	if (dist < 0.001) return [start, end];

	const offset = dist * 0.2; // 20% of distance as offset
	const cx = midLat - dLng * (offset / dist);
	const cy = midLng + dLat * (offset / dist);

	const curvePoints: [number, number][] = [];
	for (let i = 0; i <= segments; i++) {
		const t = i / segments;
		const invT = 1 - t;
		
		const lat = invT * invT * lat1 + 2 * invT * t * cx + t * t * lat2;
		const lng = invT * invT * lng1 + 2 * invT * t * cy + t * t * lng2;
		
		curvePoints.push([lat, lng]);
	}
	
	return curvePoints;
}

// Generate a full path combining multiple points with curves
export function generateCurvedPath(points: [number, number][], segmentsPerCurve = 25): [number, number][] {
	if (points.length < 2) return points;
	
	const fullPath: [number, number][] = [];
	for (let i = 0; i < points.length - 1; i++) {
		const curve = getBezierCurve(points[i], points[i+1], segmentsPerCurve);
		// Add curve points, omitting the last point to avoid duplicates (except for the final curve)
		if (i < points.length - 2) {
			fullPath.push(...curve.slice(0, -1));
		} else {
			fullPath.push(...curve);
		}
	}
	return fullPath;
}
