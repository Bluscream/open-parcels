import L from "leaflet";
import {
  Bike,
  Helicopter,
  Home,
  MapPin,
  Package,
  Plane,
  Ship,
  Train,
  Truck,
  Van,
} from "lucide-react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";

export type LatLng = [number, number];

export function createDivIcon(iconNode: ReactNode, color: string, containerSize = 32): L.DivIcon {
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
        filter: "drop-shadow(0px 2px 4px rgba(0,0,0,0.6))",
      }}
    >
      {iconNode}
    </div>,
  );
  return L.divIcon({
    html,
    className: "custom-leaflet-icon",
    iconSize: [containerSize, containerSize],
    iconAnchor: [containerSize / 2, containerSize / 2],
    popupAnchor: [0, -containerSize / 2],
  });
}

export const iconHome = createDivIcon(<Home size={28} />, "#10b981", 36);
export const iconPackage = createDivIcon(<Package size={24} />, "#818cf8", 32);
export const iconTruck = createDivIcon(<Truck size={24} />, "#ea580c", 32);
export const iconVan = createDivIcon(<Van size={24} />, "#f59e0b", 32);
export const iconPlane = createDivIcon(<Plane size={24} />, "#60a5fa", 32);
export const iconShip = createDivIcon(<Ship size={24} />, "#3b82f6", 32);
export const iconTrain = createDivIcon(<Train size={24} />, "#a855f7", 32);
export const iconSource = createDivIcon(<MapPin size={24} />, "#ef4444", 28);
export const iconIntermediate = createDivIcon(<MapPin size={20} />, "#9ca3af", 24);
export const iconCurrent = createDivIcon(<MapPin size={24} fill="#3b82f6" />, "#3b82f6", 28);
export const iconHeli = createDivIcon(<Helicopter size={24} />, "#06b6d4", 32);
export const iconBike = createDivIcon(<Bike size={24} />, "#22c55e", 32);

const TRANSPORT_ICONS: Readonly<Record<string, L.DivIcon>> = {
  plane: iconPlane,
  flight: iconPlane,
  ship: iconShip,
  boat: iconShip,
  train: iconTrain,
  rail: iconTrain,
  truck: iconTruck,
  van: iconVan,
  heli: iconHeli,
  helicopter: iconHeli,
  bike: iconBike,
  bicycle: iconBike,
};

export function getTransportMarkerIcon(method?: string): L.DivIcon {
  return TRANSPORT_ICONS[method?.toLowerCase() ?? ""] ?? iconPackage;
}

/**
 * Whole words or phrases in the carrier's text: "transport" is not "port", "shipment" not
 * "ship". German compounds are listed as they are written.
 */
const TRANSPORT_WORDS: readonly [string, readonly string[]][] = [
  [
    "plane",
    ["plane", "flight", "aircraft", "airplane", "air freight", "luftfracht", "flugzeug", "flying"],
  ],
  ["ship", ["ship", "boat", "schiff", "ocean", "sea freight", "seefracht", "vessel", "container"]],
  ["heli", ["helicopter", "hubschrauber"]],
  ["train", ["train", "rail", "bahn", "railway"]],
  ["bike", ["bike", "bicycle", "fahrrad", "cycling", "radfahrer"]],
  ["van", ["van", "delivery vehicle", "zustellfahrzeug", "delivery", "courier", "filiale"]],
  ["truck", ["truck", "lkw", "hauler", "laster", "freight", "cargo", "transit", "sorting"]],
];

function hasWord(text: string, word: string): boolean {
  const isLetter = (char: string): boolean => /\p{L}/u.test(char);
  let from = text.indexOf(word);
  while (from !== -1) {
    const before = from === 0 ? "" : text.charAt(from - 1);
    const after = text.charAt(from + word.length);
    if (!isLetter(before) && !isLetter(after)) return true;
    from = text.indexOf(word, from + 1);
  }
  return false;
}

/** Guesses how a parcel travels from its newest history text. */
export function determineTransportMethod(
  events: readonly { readonly raw_status: string; readonly timestamp: string }[],
): string {
  const newestFirst = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  for (const event of newestFirst) {
    const text = event.raw_status.toLowerCase();
    const match = TRANSPORT_WORDS.find(([, words]) => words.some((word) => hasWord(text, word)));
    if (match !== undefined) {
      return match[0];
    }
  }
  return "unknown";
}

/** A quadratic Bézier curve between two coordinates, bowed to one side. */
export function getBezierCurve(start: LatLng, end: LatLng, segments = 50): LatLng[] {
  const [lat1, lng1] = start;
  const [lat2, lng2] = end;
  const dLat = lat2 - lat1;
  const dLng = lng2 - lng1;
  const dist = Math.sqrt(dLat * dLat + dLng * dLng);
  if (dist < 0.001) {
    return [start, end];
  }
  const offset = dist * 0.2;
  const cx = (lat1 + lat2) / 2 - dLng * (offset / dist);
  const cy = (lng1 + lng2) / 2 + dLat * (offset / dist);
  const points: LatLng[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const inv = 1 - t;
    points.push([
      inv * inv * lat1 + 2 * inv * t * cx + t * t * lat2,
      inv * inv * lng1 + 2 * inv * t * cy + t * t * lng2,
    ]);
  }
  return points;
}

/** Joins several points with curves. */
export function generateCurvedPath(points: readonly LatLng[], segmentsPerCurve = 25): LatLng[] {
  if (points.length < 2) {
    return [...points];
  }
  const path: LatLng[] = [];
  points.slice(0, -1).forEach((point, index) => {
    const next = points[index + 1];
    if (next === undefined) {
      return;
    }
    const curve = getBezierCurve(point, next, segmentsPerCurve);
    path.push(...(index < points.length - 2 ? curve.slice(0, -1) : curve));
  });
  return path;
}
