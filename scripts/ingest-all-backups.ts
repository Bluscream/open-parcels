import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";
import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { orders, parcels } from "../src/db/schema";
import { getActiveParcelRules, getActiveOrderRules, getActiveReturnRules, getActiveDunningRules, loadRemoteRules } from "../src/services/ingest/rules-loader";
import { TrackingParser, EmailParser } from "../src/services/ingest/parser";
import { isDomainMatched } from "mail-parser-ts";

dotenv.config();
if (process.env.NODE_ENV !== "production") {
	dotenv.config({ path: ".env.local", override: true });
}

const MAILS_DIR = "B:\\Timo\\mails";

function decodeMimeHeader(str: string): string {
	return str.replace(
		/=\?([^?]+)\?([QB])\?([^?]*)\?=/gi,
		(match, charset, encoding, text) => {
			try {
				if (encoding.toUpperCase() === "B") {
					return Buffer.from(text, "base64").toString(
						charset.toLowerCase() === "utf-8" ? "utf8" : "latin1"
					);
				}
				if (encoding.toUpperCase() === "Q") {
					const hexDecoded = text.replace(/_/g, " ").replace(
						/=([0-9A-F]{2})/gi,
						(_: any, hex: string) => String.fromCharCode(parseInt(hex, 16))
					);
					return Buffer.from(hexDecoded, "binary").toString(
						charset.toLowerCase() === "utf-8" ? "utf8" : "latin1"
					);
				}
			} catch { }
			return match;
		}
	);
}

function parseFoldedHeader(headersText: string, name: string): string {
	const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, "im");
	const m = headersText.match(re);
	if (!m) return "";
	return decodeMimeHeader(m[1].replace(/\r?\n[ \t]+/g, " ").trim());
}

async function main() {
	console.log("Loading rules...");
	await loadRemoteRules().catch((err) => {
		console.error("Failed to load rules:", err);
	});

	const parcelRules = getActiveParcelRules();
	const orderRules = getActiveOrderRules();
	const returnRules = getActiveReturnRules();
	const dunningRules = getActiveDunningRules();
	const allRules = [...parcelRules, ...orderRules, ...returnRules, ...dunningRules];

	console.log(`Scanning backup mails in: ${MAILS_DIR}`);
	if (!fs.existsSync(MAILS_DIR)) {
		console.error("Mails directory does not exist!");
		process.exit(1);
	}

	const files = fs.readdirSync(MAILS_DIR).filter(f => f.endsWith(".eml"));
	const totalFiles = files.length;
	console.log(`Found ${totalFiles} .eml files to scan.`);

	let processedCount = 0;
	let ingestedCount = 0;
	let orderCount = 0;
	let parcelCount = 0;

	const startTime = Date.now();

	for (const filename of files) {
		processedCount++;
		const filePath = path.join(MAILS_DIR, filename);

		try {
			// Quick header check
			const fd = fs.openSync(filePath, "r");
			const buffer = Buffer.alloc(30000);
			const bytesRead = fs.readSync(fd, buffer, 0, 30000, 0);
			fs.closeSync(fd);

			const fileChunk = buffer.toString("utf8", 0, bytesRead);
			const headerEndIndex = fileChunk.indexOf("\n\n");
			const headersText = headerEndIndex !== -1 ? fileChunk.substring(0, headerEndIndex) : fileChunk;

			const from = parseFoldedHeader(headersText, "From").toLowerCase();
			const subject = parseFoldedHeader(headersText, "Subject");

			const matchingRule = allRules.find(r => isDomainMatched(from, r.domains));
			if (!matchingRule) {
				continue;
			}

			// Read full file content
			const rawContent = fs.readFileSync(filePath, "utf8");
			const mail = await simpleParser(rawContent);

			const text = mail.text || EmailParser.extractBody(mail.html || "");
			const parser = new TrackingParser(from, subject, text);
			const trackingData = parser.parse();

			if (!trackingData) continue;

			let dbOrderId: number | null = null;
			let dbParcelId: number | null = null;

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
					orderCount++;
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
					parcelCount++;
				}
			}

			if (dbOrderId && dbParcelId) {
				await db.update(parcels).set({ orderId: dbOrderId }).where(eq(parcels.id, dbParcelId));
			}

			ingestedCount++;
		} catch (err) {
			// Skip errors
		}

		if (processedCount % 1000 === 0 || processedCount === totalFiles) {
			const elapsed = (Date.now() - startTime) / 1000;
			const rate = Math.round(processedCount / elapsed);
			const percent = Math.round((processedCount / totalFiles) * 100);
			console.log(
				`Progress: ${processedCount}/${totalFiles} (${percent}%) | ` +
				`Ingested: ${ingestedCount} | ` +
				`Orders Created: ${orderCount} | ` +
				`Parcels Created: ${parcelCount} | ` +
				`Speed: ${rate} emails/sec`
			);
		}
	}

	const totalTime = (Date.now() - startTime) / 1000;
	console.log(`\nScan completed in ${totalTime.toFixed(2)}s`);
	console.log(`Total ingested emails: ${ingestedCount}`);
	console.log(`Orders created: ${orderCount}`);
	console.log(`Parcels created: ${parcelCount}`);
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
