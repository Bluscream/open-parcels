import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";
import { Client } from "ssh2";
import { simpleParser } from "mailparser";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { orders, parcels } from "../src/db/schema";
import { loadRemoteRules } from "../src/services/ingest/rules-loader";
import { TrackingParser, EmailParser } from "../src/services/ingest/parser";

dotenv.config();
if (process.env.NODE_ENV !== "production") {
	dotenv.config({ path: ".env.local", override: true });
}

// Config
const TEMP_DIR = process.env.TEMP || process.env.TMP || "C:\\Temp";
const TARGET_DIR = path.join(TEMP_DIR, "mails");
const LOCAL_MAILS_DIR = process.env.MAILS_LOCAL_DIR || "B:\\mails";

const SSH_CONFIG = {
	host: process.env.SSH_HOST || "192.168.2.11",
	port: Number(process.env.SSH_PORT) || 22,
	username: process.env.SSH_USER || "root",
	password: process.env.SSH_PASSWORD,
};

async function getNewestFilenames(): Promise<string[]> {
	return new Promise((resolve, reject) => {
		const conn = new Client();
		conn.on("ready", () => {
			console.log("[SSH] Connection established successfully.");
			// Find the 5000 newest .eml files and filter for those from non-Amazon carriers using grep on NAS
			const nasMailsDir = process.env.NAS_MAILS_DIR || "/mnt/user/backups/mails";
			const cmd = `find ${nasMailsDir}/ -name "*.eml" -type f -printf "%T@ %p\\n" | sort -rn | head -n 5000 | cut -d' ' -f2- | xargs grep -l -i -E "^From:.*(dhl|hermes|aliexpress|dpd|ups|gls)" | head -n 100`;
			
			conn.exec(cmd, (err, stream) => {
				if (err) {
					conn.end();
					return reject(err);
				}
				let stdout = "";
				stream.on("data", (data: any) => {
					stdout += data.toString();
				});
				stream.on("close", () => {
					conn.end();
					const filepaths = stdout.split("\n").map(f => f.trim()).filter(Boolean);
					resolve(filepaths);
				});
			});
		}).on("error", (err) => {
			reject(err);
		}).connect(SSH_CONFIG);
	});
}

async function main() {
	console.log("Loading rules...");
	await loadRemoteRules().catch((err) => {
		console.error("Failed to load rules:", err);
	});

	if (!fs.existsSync(TARGET_DIR)) {
		fs.mkdirSync(TARGET_DIR, { recursive: true });
	}

	console.log("[SSH] Fetching the 500 newest email filenames from the NAS...");
	let newestFiles: string[] = [];
	try {
		newestFiles = await getNewestFilenames();
		console.log(`[SSH] Successfully retrieved ${newestFiles.length} newest filenames.`);
	} catch (sshErr) {
		console.error("[SSH] Failed to retrieve files via SSH:", (sshErr as Error).message);
		process.exit(1);
	}

	console.log(`Scanning local files in ${LOCAL_MAILS_DIR} using SSH sorted list...`);
	let matchCount = 0;
	const selectedFiles: string[] = [];

	for (const fullPath of newestFiles) {
		const filename = path.basename(fullPath);
		const filePath = path.join(LOCAL_MAILS_DIR, filename);
		if (!fs.existsSync(filePath)) continue;

		try {
			const rawContent = fs.readFileSync(filePath, "utf8");
			const mail = await simpleParser(rawContent);

			const from = mail.from?.value[0]?.address || "";
			const subject = mail.subject || "";
			const text = mail.text || EmailParser.extractBody(mail.html || "");

			const parser = new TrackingParser(from, subject, text);
			const trackingData = parser.parse();

			if (trackingData) {
				const hasOrder = !!trackingData.platform?.order_number;
				const hasTracking = !!trackingData.courier?.tracking_number;

				if (hasOrder || hasTracking) {
					console.log(`[Found Match] File: ${filename} | Subj: ${subject} | From: ${from}`);
					const targetPath = path.join(TARGET_DIR, filename);
					fs.writeFileSync(targetPath, rawContent, "utf8");
					selectedFiles.push(filename);
					matchCount++;

					if (matchCount >= 10) {
						console.log("Found 10 matching emails. Stopping scan.");
						break;
					}
				}
			}
		} catch (err) {
			// Skip parsing errors
		}
	}

	console.log(`\nCopied ${selectedFiles.length} matching emails to ${TARGET_DIR}`);

	// Now ingest these selected emails into the database
	console.log("\nStarting Ingestion of selected emails...");
	let ingestedCount = 0;
	let orderCount = 0;
	let parcelCount = 0;

	for (const file of selectedFiles) {
		const filePath = path.join(TARGET_DIR, file);
		try {
			const rawContent = fs.readFileSync(filePath, "utf8");
			const mail = await simpleParser(rawContent);

			const from = mail.from?.value[0]?.address || "";
			const subject = mail.subject || "";
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
					console.log(`[Order Ingested] Platform: ${platformName} | OrderNo: ${orderNo}`);
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
					console.log(`[Parcel Ingested] Courier: ${courierName} | TrackingNo: ${trackingNumber}`);
				}
			}

			if (dbOrderId && dbParcelId) {
				await db.update(parcels).set({ orderId: dbOrderId }).where(eq(parcels.id, dbParcelId));
				console.log(`[Linked] Order ID ${dbOrderId} <--> Parcel ID ${dbParcelId}`);
			}

			ingestedCount++;
		} catch (err) {
			console.error(`Failed to ingest ${file}:`, (err as Error).message);
		}
	}

	console.log(`\n✔ Ingestion of selected emails completed successfully!`);
	console.log(`Ingested ${ingestedCount} emails`);
	console.log(`Created ${orderCount} new orders`);
	console.log(`Created ${parcelCount} new parcels`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
