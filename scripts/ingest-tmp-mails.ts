import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";
dotenv.config();
if (process.env.NODE_ENV !== "production") {
	dotenv.config({ path: ".env.local", override: true });
}

import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { orders, parcels } from "../src/db/schema";
import { loadRemoteRules } from "../src/services/ingest/rules-loader";
import { TrackingParser, EmailParser } from "../src/services/ingest/parser";
import { trackAndUpdateParcel, aggregator } from "../src/services/tracking/aggregator";

const MAILS_DIR = "/tmp/mails";

async function main() {
	console.log("Loading rules...");
	await loadRemoteRules().catch((err) => {
		console.error("Failed to load rules:", err);
	});

	if (!fs.existsSync(MAILS_DIR)) {
		console.error(`Mails directory does not exist at ${MAILS_DIR}!`);
		process.exit(1);
	}

	const files = fs.readdirSync(MAILS_DIR).filter((f) => f.endsWith(".eml"));
	console.log(`Found ${files.length} emails to process in ${MAILS_DIR}`);

	let ingestedCount = 0;
	let orderCount = 0;
	let parcelCount = 0;

	for (const file of files) {
		const filePath = path.join(MAILS_DIR, file);
		try {
			const rawContent = fs.readFileSync(filePath, "utf8");
			const mail = await simpleParser(rawContent);

			const from = mail.from?.value[0]?.address || "";
			const subject = mail.subject || "";
			const text = mail.text || EmailParser.extractBody(mail.html || "");

			const parser = new TrackingParser(from, subject, text);
			const trackingData = parser.parse();

			if (!trackingData) {
				continue;
			}

			let dbOrderId: number | null = null;
			let dbParcelId: number | null = null;

			// 1. Handle Order Ingestion
			const platformName = trackingData.platform?.name || "Unknown";
			const orderNo = trackingData.platform?.order_number;

			if (orderNo) {
				// Check duplicate order
				const existingOrder = await db
					.select()
					.from(orders)
					.where(and(eq(orders.orderNumber, orderNo), eq(orders.source, platformName)))
					.limit(1);

				if (existingOrder.length > 0) {
					dbOrderId = existingOrder[0].id;
				} else {
					const newOrder = await db
						.insert(orders)
						.values({
							source: platformName,
							orderNumber: orderNo,
							status: trackingData.type || "ordered",
							placedAt: mail.date || null,
							addedAt: new Date(),
							updatedAt: new Date(),
						})
						.returning();
					dbOrderId = newOrder[0].id;
					orderCount++;
					console.log(`[Order] Created Order ${orderNo} (${platformName})`);
				}

				// For marketplace platforms (Amazon, AliExpress, etc.),
				// call the aggregator to resolve tracking numbers from the order ID,
				// then create and link parcels automatically.
				const isMarketplace = ["amazon", "aliexpress"].includes(platformName.toLowerCase());
				if (isMarketplace) {
					try {
						const trackingInfo = await aggregator.aggregate(orderNo);
						if (trackingInfo && trackingInfo.raw) {
							const orderResp = (trackingInfo.raw as any).response;
							// Collect carrier tracking numbers from the order response
							const carrierTrackers: Array<{ tracking_id: string; carrier?: string }> = [];

							if (orderResp && Array.isArray(orderResp.shipments)) {
								for (const s of orderResp.shipments) {
									if (s.tracking_id) carrierTrackers.push({ tracking_id: s.tracking_id, carrier: s.carrier });
								}
							}
							// Also check top-level tracking_numbers (AliExpress returns these directly)
							if (Array.isArray(orderResp?.tracking_numbers)) {
								for (const tn of orderResp.tracking_numbers) {
									if (!carrierTrackers.find(c => c.tracking_id === tn)) {
										carrierTrackers.push({ tracking_id: tn, carrier: orderResp.carrier });
									}
								}
							}
							// If aggregator resolved to a real carrier tracking number, add it
							if (trackingInfo.trackingNumber && trackingInfo.trackingNumber !== orderNo &&
								!carrierTrackers.find(c => c.tracking_id === trackingInfo.trackingNumber)) {
								carrierTrackers.push({ tracking_id: trackingInfo.trackingNumber, carrier: trackingInfo.courier });
							}

							for (const { tracking_id, carrier } of carrierTrackers) {
								if (!tracking_id) continue;

								let existingParcel = await db
									.select()
									.from(parcels)
									.where(eq(parcels.trackingNumber, tracking_id))
									.limit(1);

								let parcelId: number;
								if (existingParcel.length === 0) {
									const newP = await db
										.insert(parcels)
										.values({
											trackingNumber: tracking_id,
											status: "ordered",
											courier: carrier || platformName,
											orderId: dbOrderId,
											addedAt: new Date(),
											updatedAt: new Date(),
										})
										.returning();
									parcelId = newP[0].id;
									parcelCount++;
									console.log(`[Parcel] Created Parcel ${tracking_id} (${carrier || platformName}) via Order Aggregation`);
								} else {
									parcelId = existingParcel[0].id;
									await db.update(parcels).set({ orderId: dbOrderId }).where(eq(parcels.id, parcelId));
									console.log(`[Link] Linked Order ${dbOrderId} with Parcel ${parcelId} via Order Aggregation`);
								}

								// Trigger tracking update
								trackAndUpdateParcel(parcelId).catch((err) => {
									console.error(`Failed to track parcel ${tracking_id}:`, err.message);
								});
							}
						}
					} catch (aggErr) {
						console.error(`Failed to aggregate order ${orderNo}:`, (aggErr as Error).message);
					}
				}

			}

			// 2. Handle Parcel Ingestion
			const trackingNumber = trackingData.courier?.tracking_number;
			const courierName = trackingData.courier?.name || platformName;

			if (trackingNumber) {
				const existingParcel = await db
					.select()
					.from(parcels)
					.where(eq(parcels.trackingNumber, trackingNumber))
					.limit(1);

				if (existingParcel.length > 0) {
					dbParcelId = existingParcel[0].id;
				} else {
					const newParcel = await db
						.insert(parcels)
						.values({
							trackingNumber,
							name: trackingData.items?.[0]?.name || null,
							courier: courierName,
							status: trackingData.type || "ordered",
							addedAt: new Date(),
							updatedAt: new Date(),
						})
						.returning();
					dbParcelId = newParcel[0].id;
					parcelCount++;
					console.log(`[Parcel] Created Parcel ${trackingNumber} (${courierName})`);

					// Try to fetch active tracking updates in background (will be queued by rate limiter if needed)
					trackAndUpdateParcel(dbParcelId).catch((err) => {
						console.error(`Failed to track parcel ${trackingNumber}:`, err.message);
					});
				}
			}

			// 3. Link Order and Parcel (standard flow)
			if (dbOrderId && dbParcelId) {
				await db.update(parcels).set({ orderId: dbOrderId }).where(eq(parcels.id, dbParcelId));
				console.log(`[Link] Linked Order ${dbOrderId} with Parcel ${dbParcelId}`);
			}

			ingestedCount++;
		} catch (err) {
			console.error(`Failed to process email ${file}:`, (err as Error).message);
		}
	}

	console.log(`\n✔ Ingestion finished!`);
	console.log(`Processed ${ingestedCount} matching emails`);
	console.log(`Created ${orderCount} orders`);
	console.log(`Created ${parcelCount} parcels`);
}

main().catch((err) => {
	console.error("Fatal error during manual ingestion:", err);
	process.exit(1);
});
