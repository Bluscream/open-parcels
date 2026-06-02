import L from "leaflet";
import { Home, Package, Plane, Ship, Train, Truck, MapPin } from "lucide-react";
import React from "react";
import { renderToString } from "react-dom/server";

export const createDivIcon = (iconNode: React.ReactNode, color: string) => {
	const html = renderToString(
		<div
			style={{
				color,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				width: "32px",
				height: "32px",
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
		iconSize: [32, 32],
		iconAnchor: [16, 16],
		popupAnchor: [0, -16],
	});
};

export const iconHome = createDivIcon(<Home size={24} />, "#10b981"); // Emerald
export const iconPackage = createDivIcon(<Package size={24} />, "#818cf8"); // Indigo
export const iconTruck = createDivIcon(<Truck size={24} />, "#f59e0b"); // Amber
export const iconPlane = createDivIcon(<Plane size={24} />, "#60a5fa"); // Blue
export const iconShip = createDivIcon(<Ship size={24} />, "#3b82f6"); // Darker Blue
export const iconTrain = createDivIcon(<Train size={24} />, "#a855f7"); // Purple
export const iconSource = createDivIcon(<MapPin size={24} />, "#ef4444"); // Red
export const iconIntermediate = createDivIcon(<MapPin size={20} />, "#9ca3af"); // Gray
export const iconCurrent = createDivIcon(<MapPin size={24} fill="#3b82f6" />, "#3b82f6"); // Blue filled

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
		case "van":
			return iconTruck;
		default:
			return iconPackage;
	}
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
