/**
 * Formats an estimated delivery date as a human-friendly relative string.
 * e.g. "Arriving in ~2 days", "Arriving in ~4 hours", "Arrived 1 day ago"
 */
export function formatRelativeEta(dateStr: string | undefined | null): string | null {
	if (!dateStr) return null;
	const date = new Date(dateStr);
	if (Number.isNaN(date.getTime())) return null;

	const diffMs = date.getTime() - Date.now();
	const diffMins = Math.round(diffMs / 60000);
	const diffHours = Math.round(diffMs / 3600000);
	const diffDays = Math.round(diffMs / 86400000);

	const past = diffMs < 0;
	const abs = Math.abs;

	if (abs(diffDays) >= 2) {
		return past
			? `Arrived ~${abs(diffDays)} days ago`
			: `Arriving in ~${abs(diffDays)} days`;
	}
	if (abs(diffDays) >= 1) {
		return past ? "Arrived ~1 day ago" : "Arriving in ~1 day";
	}
	if (abs(diffHours) >= 2) {
		return past
			? `Arrived ~${abs(diffHours)} hours ago`
			: `Arriving in ~${abs(diffHours)} hours`;
	}
	if (abs(diffHours) >= 1) {
		return past ? "Arrived ~1 hour ago" : "Arriving in ~1 hour";
	}
	if (abs(diffMins) >= 2) {
		return past
			? `Arrived ~${abs(diffMins)} minutes ago`
			: `Arriving in ~${abs(diffMins)} minutes`;
	}
	return past ? "Just arrived" : "Arriving very soon";
}
