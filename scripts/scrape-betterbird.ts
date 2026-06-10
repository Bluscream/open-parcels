import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const SOURCE_DIR = "/home/blu/.var/app/eu.betterbird.Betterbird/.thunderbird/jhkwuup6.default-default";
const OUTPUT_DIR = "/var/mnt/nas_nfs/backups/Timo/mails";
const CSV_PATH = path.join(OUTPUT_DIR, "mails.csv");
const START_TIME = 1779959383; // Arrived after this unixtime

const MAIL_SUBDIRS = ["ImapMail", "Mail"];

// ── Live progress helpers ────────────────────────────────────────────────────

function commitLine(line: string) {
	console.log(line);
}

// ── CSV helpers ──────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
	const escaped = value.replace(/"/g, '""');
	return `"${escaped}"`;
}

function csvAppend(md5: string, unixtime: number, from: string, to: string, subject: string) {
	const row = [
		csvEscape(md5),
		unixtime.toString(),
		csvEscape(from),
		csvEscape(to),
		csvEscape(subject),
	].join(";");
	fs.appendFileSync(CSV_PATH, `${row}\n`, "utf8");
}

// ── RFC 2047 MIME Header Decoder ─────────────────────────────────────────────

function decodeMimeHeader(str: string): string {
	return str.replace(
		/=\?([^?]+)\?([QB])\?([^?]*)\?=/gi,
		(match: string, charset: string, encoding: string, text: string) => {
			try {
				if (encoding.toUpperCase() === "B") {
					return Buffer.from(text, "base64").toString(
						charset.toLowerCase() === "utf-8" ? "utf8" : "latin1",
					);
				}
				if (encoding.toUpperCase() === "Q") {
					const encodedText = text.replace(/_/g, " ");
					const hexDecoded = encodedText.replace(
						/=([0-9A-F]{2})/gi,
						(_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)),
					);
					return Buffer.from(hexDecoded, "binary").toString(
						charset.toLowerCase() === "utf-8" ? "utf8" : "latin1",
					);
				}
			} catch (_e) {
				// fallback
			}
			return match;
		},
	);
}

// ── Filename sanitizer ───────────────────────────────────────────────────────

function escapeFilename(subject: string): string {
	return (
		subject
			.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
			.replace(/\s+/g, "_")
			.replace(/__+/g, "_")
			.trim()
			.substring(0, 100)
	);
}

// ── Header parser ────────────────────────────────────────────────────────────

function parseFoldedHeader(headersText: string, name: string): string {
	const re = new RegExp(`^${name}:\\s*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, "im");
	const m = headersText.match(re);
	if (!m) return "";
	return decodeMimeHeader(m[1].replace(/\r?\n[ \t]+/g, " ").trim());
}

function parseHeaders(headersText: string): {
	unixStamp: number;
	subjectEscaped: string;
	subject: string;
	from: string;
	to: string;
} {
	const subject = parseFoldedHeader(headersText, "Subject") || "no_subject";
	const from = parseFoldedHeader(headersText, "From");
	const to = parseFoldedHeader(headersText, "To");

	const dateStr = parseFoldedHeader(headersText, "Date");
	let unixStamp = Math.floor(Date.now() / 1000);
	if (dateStr) {
		const parsedDate = Date.parse(dateStr);
		if (!Number.isNaN(parsedDate)) {
			unixStamp = Math.floor(parsedDate / 1000);
		}
	}

	return { unixStamp, subjectEscaped: escapeFilename(subject), subject, from, to };
}

// ── Mbox parser ─────────────────────────────────────────────────────────────

function* parseMbox(content: string): Generator<string> {
	const lines = content.split(/\r?\n/);
	let currentMessage: string[] = [];
	let inMessage = false;

	for (const line of lines) {
		if (line.startsWith("From ") && !inMessage) {
			inMessage = true;
			continue;
		}

		if (line.startsWith("From ") && inMessage) {
			if (currentMessage.length > 0) {
				yield currentMessage.join("\n");
			}
			currentMessage = [];
			continue;
		}

		if (inMessage) {
			currentMessage.push(line);
		}
	}

	if (currentMessage.length > 0) {
		yield currentMessage.join("\n");
	}
}

// ── File scanner ────────────────────────────────────────────────────────────

function findMboxFiles(dir: string): string[] {
	const mboxFiles: string[] = [];

	if (!fs.existsSync(dir)) {
		return mboxFiles;
	}

	function scan(currentDir: string, inMailDir: boolean = false) {
		const entries = fs.readdirSync(currentDir, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				const isMailDir = MAIL_SUBDIRS.includes(entry.name);
				if (isMailDir || inMailDir) {
					scan(fullPath, true);
				}
			} else if (entry.isFile() && inMailDir) {
				if (!entry.name.endsWith(".msf") && 
					!entry.name.endsWith(".dat") && 
					!entry.name.endsWith(".json") &&
					!entry.name.endsWith(".sqlite") &&
					!entry.name.endsWith(".db") &&
					!entry.name.endsWith(".bin") &&
					!entry.name.endsWith(".lz4") &&
					!entry.name.endsWith(".txt") &&
					!entry.name.startsWith(".")) {
					try {
						const stats = fs.statSync(fullPath);
						if (stats.isFile() && stats.size > 0) {
							mboxFiles.push(fullPath);
						}
					} catch {
						// skip
					}
				}
			}
		}
	}

	scan(dir);
	return mboxFiles;
}

// ── Email extractor ───────────────────────────────────────────────────────────

async function extractEmailsFromMbox(mboxPath: string): Promise<{ total: number; saved: number; skipped: number; errors: number }> {
	const relativePath = path.relative(SOURCE_DIR, mboxPath);

	commitLine(`\n▸ Processing: ${relativePath}`);

	let total = 0;
	let saved = 0;
	let skipped = 0;
	let errors = 0;

	try {
		const content = fs.readFileSync(mboxPath, "utf8");
		
		for (const emailContent of parseMbox(content)) {
			total++;
			
			try {
				const headerEndIndex = emailContent.indexOf("\n\n");
				const headersText = headerEndIndex !== -1 
					? emailContent.substring(0, headerEndIndex)
					: emailContent;

				const { unixStamp, subject, from, to } = parseHeaders(headersText);
				
				// Apply cutoff filter
				if (unixStamp <= START_TIME) {
					skipped++;
					continue;
				}
				
				const md5 = crypto.createHash("md5").update(emailContent, "utf8").digest("hex");
				const finalPath = path.join(OUTPUT_DIR, `${md5}.eml`);

				if (fs.existsSync(finalPath)) {
					skipped++;
					continue;
				}

				await fs.promises.writeFile(finalPath, emailContent, "utf8");
				csvAppend(md5, unixStamp, from, to, subject);
				saved++;
				console.log(`  [${relativePath}] ${total} — Saved: ${subject} (${new Date(unixStamp * 1000).toLocaleString()})`);
			} catch (err) {
				errors++;
				console.log(`  [${relativePath}] ${total} — [error] ${(err as Error).message}`);
			}
		}
	} catch (err) {
		commitLine(`  ✗ Failed to read ${mboxPath}: ${(err as Error).message}`);
		return { total: 0, saved: 0, skipped: 0, errors: 1 };
	}

	commitLine(`  ✓ ${relativePath} — ${saved}/${total} saved, ${skipped} skipped (older/duplicate), ${errors} errors`);
	return { total, saved, skipped, errors };
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
	commitLine(`Source directory: ${SOURCE_DIR}`);
	commitLine(`Output directory: ${OUTPUT_DIR}`);
	commitLine(`Incremental limit: Only emails after ${new Date(START_TIME * 1000).toLocaleString()}`);
	
	if (!fs.existsSync(SOURCE_DIR)) {
		commitLine(`Fatal: Source profile directory not found: ${SOURCE_DIR}`);
		return;
	}

	fs.mkdirSync(OUTPUT_DIR, { recursive: true });

	const allMboxFiles = findMboxFiles(SOURCE_DIR);
	commitLine(`Found ${allMboxFiles.length} mbox files to scan.`);

	if (allMboxFiles.length === 0) {
		commitLine("No mbox files found. Exiting.");
		return;
	}

	const startTime = Date.now();
	let grandTotal = 0;
	let grandSaved = 0;
	let grandSkipped = 0;
	let grandErrors = 0;

	for (const mboxFile of allMboxFiles) {
		const result = await extractEmailsFromMbox(mboxFile);
		grandTotal += result.total;
		grandSaved += result.saved;
		grandSkipped += result.skipped;
		grandErrors += result.errors;
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	commitLine(`\n✔ All done in ${elapsed}s`);
	commitLine(`Total emails scanned: ${grandTotal}`);
	commitLine(`Saved (new): ${grandSaved}`);
	commitLine(`Skipped (old/duplicate): ${grandSkipped}`);
	commitLine(`Errors: ${grandErrors}`);
}

main().catch((err) => {
	commitLine(`\nFatal error: ${(err as Error).message}`);
	process.exit(1);
});
