/* biome-ignore-all lint/suspicious/noExplicitAny: frontend uses any */
/* biome-ignore-all lint/a11y: disable a11y rules */
import type React from "react";
import { useEffect, useState } from "react";
import { Package } from "lucide-react";
import { getGuestToken } from "../utils/auth";

interface CourierInfo {
	id: string;
	name: string;
	iconUrl?: string;
}

// Module-level cache so all components share a single fetch
let cachedCourierMap: Map<string, CourierInfo> | null = null;
let fetchPromise: Promise<Map<string, CourierInfo>> | null = null;

export function useCourierMap(): Map<string, CourierInfo> {
	const [courierMap, setCourierMap] = useState<Map<string, CourierInfo>>(
		() => cachedCourierMap ?? new Map(),
	);

	useEffect(() => {
		if (cachedCourierMap) return;
		if (!fetchPromise) {
			fetchPromise = fetch(`/api/v1/couriers?token=${getGuestToken()}`)
				.then((r) => r.json())
				.then((data: CourierInfo[]) => {
					const map = new Map<string, CourierInfo>();
					if (Array.isArray(data)) {
						for (const c of data) {
							map.set(c.id.toLowerCase(), c);
							map.set(c.name.toLowerCase(), c);
						}
					}
					cachedCourierMap = map;
					return map;
				})
				.catch(() => new Map<string, CourierInfo>());
		}
		fetchPromise.then((map) => setCourierMap(map));
	}, []);

	return courierMap;
}

/** Resolve a courier name/id string to its CourierInfo entry */
export function resolveCourier(
	courierMap: Map<string, CourierInfo>,
	courier: string,
): CourierInfo | undefined {
	const key = (courier || "").toLowerCase();
	// Exact match first
	if (courierMap.has(key)) return courierMap.get(key);
	// Substring match: courier name contains a known key
	for (const [k, v] of courierMap) {
		if (key.includes(k)) return v;
	}
	return undefined;
}

interface CourierLogoProps {
	courier: string;
	size?: number;
}

/** Renders the courier logo if resolvable, falls back to a Package icon */
export const CourierLogo: React.FC<CourierLogoProps> = ({ courier, size = 28 }) => {
	const courierMap = useCourierMap();
	const resolved = resolveCourier(courierMap, courier);

	if (resolved?.iconUrl) {
		return (
			<>
				<img
					src={resolved.iconUrl}
					alt={resolved.name}
					style={{ width: size, height: size, objectFit: "contain", borderRadius: 4 }}
					onError={(e) => {
						(e.currentTarget as HTMLImageElement).style.display = "none";
						const sib = e.currentTarget.nextElementSibling as HTMLElement | null;
						if (sib) sib.style.display = "block";
					}}
				/>
				<span style={{ display: "none" }}>
					<Package size={size} className="text-purple-400" />
				</span>
			</>
		);
	}

	return <Package size={size} className="text-purple-400" />;
};
