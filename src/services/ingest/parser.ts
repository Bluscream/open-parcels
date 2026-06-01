import { parseParcelEmail, parseOrderEmail, parseReturnEmail, parseDunningEmail } from "mail-parser-ts";
import { getActiveParcelRules, getActiveOrderRules, getActiveReturnRules, getActiveDunningRules } from "./rules-loader";

export interface TrackingData {
	type: string;
	platform?: {
		name?: string;
		order_number?: string;
	};
	courier?: {
		name?: string;
		tracking_number?: string;
	};
	items?: Array<{
		id?: string;
		url?: string;
		name?: string;
		quantity?: number;
	}>;
	order_date?: string | Date | null;
	sent_date?: string | Date | null;
	arrival_date?: string | Date | null;
	return_until?: string | Date | null;
	refund?: string | number | null;
	location?: string | null;
}

export const EmailParser = {
	// Simplified for setup, will expand based on references
	extractBody(rawContent: string): string {
		// Basic extraction
		return rawContent;
	},
};

export class TrackingParser {
	private from: string;
	private subject: string;
	private bodyPlain: string;

	constructor(from: string, subject: string, bodyPlain: string) {
		this.from = from.toLowerCase();
		this.subject = subject || "";
		this.bodyPlain = bodyPlain || "";
	}

	public parse(): TrackingData | null {
		let tracking: TrackingData | null = null;

		// 1. Try to parse as a Parcel tracking email
		const parsedParcel = parseParcelEmail(this.from, this.subject, this.bodyPlain, undefined, getActiveParcelRules());
		if (parsedParcel) {
			tracking = tracking || { type: parsedParcel.status };
			tracking.type = parsedParcel.status;

			if (parsedParcel.courier === "amazon") {
				tracking.platform = tracking.platform || {};
				tracking.platform.name = "Amazon";
				tracking.platform.order_number = parsedParcel.orderNumbers?.[0] || tracking.platform.order_number;

				if (parsedParcel.deliveryDate) {
					tracking.arrival_date = parsedParcel.deliveryDate;
				}
				if (parsedParcel.secretCode) {
					if (parsedParcel.secretType === "locker") {
						tracking.location = `Amazon Hub Locker: ${parsedParcel.secretCode}`;
					} else {
						tracking.location = `Delivery Code: ${parsedParcel.secretCode}`;
					}
				}
			} else {
				tracking.courier = tracking.courier || {};
				tracking.courier.name = parsedParcel.courier.toUpperCase();
				tracking.courier.tracking_number = parsedParcel.trackingNumbers?.[0] || tracking.courier.tracking_number;
			}
		}

		// 2. Try to parse as an Order confirmation email
		const parsedOrder = parseOrderEmail(this.from, this.subject, this.bodyPlain, undefined, getActiveOrderRules());
		if (parsedOrder) {
			tracking = tracking || { type: parsedOrder.status };
			// Prefer more specific parcel status if already set, otherwise use order status
			if (!tracking.type || tracking.type === "unknown") {
				tracking.type = parsedOrder.status;
			}

			tracking.platform = tracking.platform || {};
			tracking.platform.name = parsedOrder.courier === "amazon" ? "Amazon" : parsedOrder.seller || parsedOrder.courier || tracking.platform.name;
			tracking.platform.order_number = parsedOrder.orderNumbers?.[0] || tracking.platform.order_number;
			tracking.order_date = tracking.order_date || new Date();

			if (parsedOrder.estimatedDelivery && !tracking.arrival_date) {
				tracking.arrival_date = parsedOrder.estimatedDelivery;
			}

			if (parsedOrder.itemNames && parsedOrder.itemNames.length > 0) {
				tracking.items = parsedOrder.itemNames.map(name => ({ name }));
			} else if (parsedOrder.items && parsedOrder.items.length > 0) {
				tracking.items = parsedOrder.items.map(item => ({
					name: item.name,
					quantity: item.quantity,
				}));
			}
		}

		// 3. Try to parse as a Return / Refund email
		const parsedReturn = parseReturnEmail(this.from, this.subject, this.bodyPlain, undefined, getActiveReturnRules());
		if (parsedReturn) {
			tracking = tracking || { type: parsedReturn.status };
			if (!tracking.type || tracking.type === "unknown") {
				tracking.type = parsedReturn.status;
			}

			tracking.platform = tracking.platform || {};
			tracking.platform.name = parsedReturn.courier === "amazon" ? "Amazon" : tracking.platform.name || "Merchant";
			tracking.platform.order_number = parsedReturn.orderNumbers?.[0] || tracking.platform.order_number;

			if (parsedReturn.deadline) {
				tracking.return_until = parsedReturn.deadline;
			} else if (parsedReturn.dropOffDeadline) {
				tracking.return_until = parsedReturn.dropOffDeadline;
			}

			if (parsedReturn.refundAmount) {
				tracking.refund = parsedReturn.refundAmount;
			}

			if (parsedReturn.trackingNumbers && parsedReturn.trackingNumbers.length > 0) {
				tracking.courier = tracking.courier || {};
				tracking.courier.name = parsedReturn.returnCarrier || parsedReturn.courier;
				tracking.courier.tracking_number = parsedReturn.trackingNumbers[0];
			}
		}

		// 4. Try to parse as a Dunning email
		const parsedDunning = parseDunningEmail(this.from, this.subject, this.bodyPlain, undefined, getActiveDunningRules());
		if (parsedDunning) {
			tracking = tracking || { type: parsedDunning.status };
			if (!tracking.type || tracking.type === "unknown") {
				tracking.type = parsedDunning.status;
			}

			tracking.platform = tracking.platform || {};
			tracking.platform.name = parsedDunning.merchant || parsedDunning.courier || tracking.platform.name;
			tracking.platform.order_number = parsedDunning.orderNumbers?.[0] || tracking.platform.order_number;
		}

		return tracking;
	}
}
