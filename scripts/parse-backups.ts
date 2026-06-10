import * as fs from "node:fs";
import * as path from "node:path";
import { parseParcelEmail, parseOrderEmail, parseReturnEmail, parseDunningEmail, isDomainMatched } from "mail-parser-ts";

import { rule as amazonParcel } from "../packages/email-parser-rules/src/parcel/amazon";
import { rule as auspostParcel } from "../packages/email-parser-rules/src/parcel/auspost";
import { rule as capostParcel } from "../packages/email-parser-rules/src/parcel/capost";
import { rule as dhlParcel } from "../packages/email-parser-rules/src/parcel/dhl";
import { rule as dpdParcel } from "../packages/email-parser-rules/src/parcel/dpd_com_pl";
import { rule as fedexParcel } from "../packages/email-parser-rules/src/parcel/fedex";
import { rule as glsParcel } from "../packages/email-parser-rules/src/parcel/gls";
import { rule as hermesParcel } from "../packages/email-parser-rules/src/parcel/hermes";
import { rule as inpostParcel } from "../packages/email-parser-rules/src/parcel/inpost_pl";
import { rule as pocztaParcel } from "../packages/email-parser-rules/src/parcel/poczta_polska";
import { rule as royalParcel } from "../packages/email-parser-rules/src/parcel/royal";
import { rule as upsParcel } from "../packages/email-parser-rules/src/parcel/ups";
import { rule as uspsParcel } from "../packages/email-parser-rules/src/parcel/usps";

import { rule as amazonOrder } from "../packages/email-parser-rules/src/order/amazon";
import { rule as ebayOrder } from "../packages/email-parser-rules/src/order/ebay";
import { rule as shopifyOrder } from "../packages/email-parser-rules/src/order/shopify";

import { rule as amazonReturn } from "../packages/email-parser-rules/src/return/amazon";
import { rule as paypalReturn } from "../packages/email-parser-rules/src/return/paypal";

import { rule as amazonDunning } from "../packages/email-parser-rules/src/dunning/amazon";

const parcelRules = [
	amazonParcel, auspostParcel, capostParcel, dhlParcel, dpdParcel, fedexParcel,
	glsParcel, hermesParcel, inpostParcel, pocztaParcel, royalParcel, upsParcel, uspsParcel
];
const orderRules = [amazonOrder, ebayOrder, shopifyOrder];
const returnRules = [amazonReturn, paypalReturn];
const dunningRules = [amazonDunning];

const allRules = [...parcelRules, ...orderRules, ...returnRules, ...dunningRules];

const MAILS_DIR = "/var/mnt/nfs/Backups (NAS)/Timo/mails/";
const OUTPUT_FILE = path.join(__dirname, "../parsed_mails.json");

// Decode MIME header (e.g. encoded subject lines)
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

function decodeQuotedPrintable(str: string): string {
	return str
		.replace(/=\r?\n/g, "")
		.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function parseFoldedHeader(headersText: string, name: string): string {
	const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, "im");
	const m = headersText.match(re);
	if (!m) return "";
	return decodeMimeHeader(m[1].replace(/\r?\n[ \t]+/g, " ").trim());
}

const KEYWORDS = [
	"dhl", "ups", "hermes", "fedex", "gls", "inpost", "dpd", "usps", "royal mail",
	"paket", "parcel", "delivery", "tracking", "track", "shipment", "shipping", "delivered",
	"bestellung", "order", "purchase", "kauf", "refund", "rückgabe", "retoure", "gutschrift",
	"zahlung", "paypal", "locker", "code", "verfolgen"
];

function containsKeywords(text: string): boolean {
	const lower = text.toLowerCase();
	return KEYWORDS.some(kw => lower.includes(kw));
}
async function main() {
	console.log(`Scanning backup mails in: ${MAILS_DIR}`);
	if (!fs.existsSync(MAILS_DIR)) {
		console.error("Mails directory does not exist!");
		process.exit(1);
	}

	const files = fs.readdirSync(MAILS_DIR).filter(f => f.endsWith(".eml"));
	const totalFiles = files.length;
	console.log(`Found ${totalFiles} .eml files to scan.`);

	const parsedResults: any[] = [];
	const ignoredResults: any[] = [];
	const unparsedFilesWithKeywords: any[] = [];

	let parsedCount = 0;
	let ignoredCount = 0;
	let unparsedKeywordCount = 0;
	let processedCount = 0;

	const startTime = Date.now();

	for (const filename of files) {
		processedCount++;

		const filePath = path.join(MAILS_DIR, filename);

		try {
			// Read the first 30KB of the file for quick header screening
			const fd = fs.openSync(filePath, "r");
			const buffer = Buffer.alloc(30000);
			const bytesRead = fs.readSync(fd, buffer, 0, 30000, 0);
			fs.closeSync(fd);

			const fileChunk = buffer.toString("utf8", 0, bytesRead);
			const headerEndIndex = fileChunk.indexOf("\n\n");
			const headersText = headerEndIndex !== -1 ? fileChunk.substring(0, headerEndIndex) : fileChunk;

			const from = parseFoldedHeader(headersText, "From").toLowerCase();
			const subject = parseFoldedHeader(headersText, "Subject");

			// Check if any rule matches the sender domain
			const matchingRule = allRules.find(r => isDomainMatched(from, r.domains));

			if (matchingRule) {
				// Read full file content to ensure entire body is parsed
				const fullContent = fs.readFileSync(filePath, "utf8");
				const fullHeaderEndIndex = fullContent.indexOf("\n\n");
				const fullBodyRaw = fullHeaderEndIndex !== -1 ? fullContent.substring(fullHeaderEndIndex + 2) : fullContent;
				const cte = parseFoldedHeader(headersText, "Content-Transfer-Encoding").toLowerCase();
				const fullBody = cte.includes("quoted-printable") ? decodeQuotedPrintable(fullBodyRaw) : fullBodyRaw;

				// Run ALL parsers independently — an email can match multiple types
				const results: Record<string, any> = {};
				const parcelRes  = parseParcelEmail(from, subject, fullBody, undefined, parcelRules);
				const orderRes   = parseOrderEmail(from, subject, fullBody, undefined, orderRules);
				const returnRes  = parseReturnEmail(from, subject, fullBody, undefined, returnRules);
				const dunningRes = parseDunningEmail(from, subject, fullBody, undefined, dunningRules);

				if (parcelRes)  results.parcel  = parcelRes;
				if (orderRes)   results.order   = orderRes;
				if (returnRes)  results.return  = returnRes;
				if (dunningRes) results.dunning = dunningRes;

				if (Object.keys(results).length > 0) {
					parsedResults.push({ filename, from, subject, results });
					parsedCount++;
				} else {
					ignoredResults.push({ filename, from, subject, rule: matchingRule.name });
					ignoredCount++;
				}
			} else {
				// If not parsed, check if it matches keywords
				const headerTextLower = headersText.toLowerCase();
				if (containsKeywords(headerTextLower) || containsKeywords(subject)) {
					unparsedFilesWithKeywords.push({ filename, from, subject });
					unparsedKeywordCount++;
				}
			}
		} catch (err) {
			// Skip or log parsing error for individual file
		}

		if (processedCount % 500 === 0 || processedCount === totalFiles) {
			const elapsed = (Date.now() - startTime) / 1000;
			const rate = Math.round(processedCount / elapsed);
			const percent = Math.round((processedCount / totalFiles) * 100);
			console.log(
				`Progress: ${processedCount}/${totalFiles} (${percent}%) | ` +
				`Parsed: ${parsedCount} | ` +
				`Ignored: ${ignoredCount} | ` +
				`Unparsed w/ Keywords: ${unparsedKeywordCount} | ` +
				`Speed: ${rate} emails/sec`
			);
		}
	}

	const totalTime = Date.now() - startTime;
	const elapsedSeconds = totalTime / 1000;
	const avgMsPerMail = totalFiles > 0 ? parseFloat((totalTime / totalFiles).toFixed(2)) : 0;
	const rate = elapsedSeconds > 0 ? Math.round(totalFiles / elapsedSeconds) : 0;

	const finalOutput = {
		meta: {
			totalFiles,
			processedCount,
			parsedCount,
			ignoredCount,
			unparsedKeywordCount,
			durationSeconds: parseFloat(elapsedSeconds.toFixed(2)),
			avgMsPerMail,
			speedEmailsPerSec: rate
		},
		parsed: parsedResults,
		ignored: ignoredResults,
		unparsed_keywords: unparsedFilesWithKeywords
	};

	fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalOutput, null, 2), "utf8");
	console.log(`\nScan completed in ${elapsedSeconds.toFixed(2)}s (${avgMsPerMail}ms/mail average)`);
	console.log(`Parsed results: ${parsedCount}`);
	console.log(`Ignored results: ${ignoredCount}`);
	console.log(`Unparsed matching keywords: ${unparsedKeywordCount}`);
	console.log(`Saved results to: ${OUTPUT_FILE}`);
}

main().catch(err => {
	console.error("Fatal error:", err);
	process.exit(1);
});
