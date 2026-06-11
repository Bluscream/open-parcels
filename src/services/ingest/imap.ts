import { eq, and } from "drizzle-orm";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import { db } from "../../db";
import { credentials, orders, parcels } from "../../db/schema";
import { EmailParser, TrackingParser } from "./parser";
import { decryptCredential } from "../../utils/crypto";
import { trackAndUpdateParcel } from "../tracking/aggregator";

export async function pollEmails() {
	console.log("Polling emails for tracking updates...");

	// Fetch IMAP credentials from DB
	const imapCreds = await db
		.select()
		.from(credentials)
		.where(eq(credentials.service, "IMAP"));

	if (!imapCreds || imapCreds.length === 0) {
		console.log("No IMAP credentials found. Skipping email polling.");
		return;
	}

	for (const cred of imapCreds) {
		let config: {
			user?: string;
			password?: string;
			host?: string;
			port?: number;
			tls?: boolean;
		};
		try {
			const decryptedStr = decryptCredential(cred.encryptedData);
			config = JSON.parse(decryptedStr);
		} catch (e) {
			console.error(`Failed to decrypt/parse IMAP credentials for ID ${cred.id}:`, e);
			continue;
		}

		const imapConfig = {
			imap: {
				user: config.user || "",
				password: config.password || "",
				host: config.host || "",
				port: config.port || 993,
				tls: config.tls !== false,
				authTimeout: 3000,
			},
		};

		try {
			console.log(`Connecting to IMAP host ${imapConfig.imap.host} for user ${imapConfig.imap.user}...`);
			const connection = await (imaps.connect(
				imapConfig,
			) as Promise<imaps.ImapSimple>);
			await connection.openBox("INBOX");

			// Fetch emails from the last 2 days
			const delay = 2 * 24 * 3600 * 1000;
			const since = new Date(Date.now() - delay).toISOString();

			const searchCriteria = ["UNSEEN", ["SINCE", since]];
			const fetchOptions = {
				bodies: ["HEADER", "TEXT", ""],
				markSeen: true,
			};

			const results = await connection.search(searchCriteria, fetchOptions);

			for (const item of results) {
				const all = item.parts.find(
					(part: { which: string; body: string }) => part.which === "",
				);
				if (all) {
					const mail = await simpleParser(all.body);
					const from = mail.from?.value[0]?.address || "";
					const subject = mail.subject || "";
					const text = mail.text || EmailParser.extractBody(mail.html || "");

					const parser = new TrackingParser(from, subject, text);
					const trackingData = parser.parse();

					if (trackingData) {
						console.log(
							`Found tracking data in email from ${from}:`,
							trackingData,
						);
						
						let dbOrderId: string | null = null;
						let dbParcelId: string | null = null;
						const platformName = trackingData.platform?.name || "Unknown";
						const orderNo = trackingData.platform?.order_number;

						if (orderNo) {
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
							}
						}

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

								trackAndUpdateParcel(dbParcelId).catch((err) => {
									console.error(`[IMAPAutoTrack] Failed to track parcel ${dbParcelId}:`, err);
								});
							}
						}

						if (dbOrderId && dbParcelId) {
							await db.update(parcels).set({ orderId: dbOrderId }).where(eq(parcels.id, dbParcelId));
						}
					}
				}
			}

			connection.end();
		} catch (error) {
			console.error(`IMAP Polling Error for user ${imapConfig.imap.user}:`, error);
		}
	}
}
