import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const OUTPUT_DIR = path.join(process.env.TEMP || os.tmpdir(), "mails");
const CSV_PATH = path.join(OUTPUT_DIR, "mails.csv");

// Directories to scan for Thunderbird/Betterbird email data
const SOURCE_DIRS = [
	"C:\\Users\\Bluscream\\scoop\\persist\\betterbird\\profile",
	"C:\\Users\\Bluscream\\AppData\\Roaming\\thunderbird\\Profiles",
];

// Subdirectories that contain mbox files
const MAIL_SUBDIRS = ["ImapMail", "Mail"];

// ── Live progress helpers ────────────────────────────────────────────────────

function commitLine(line: string) {
	console.log(line);
}

// ── CSV helpers ──────────────────────────────────────────────────────────────

/** Wrap a field in double-quotes and escape any internal double-quotes. */
function csvEscape(value: string): string {
	const escaped = value.replace(/"/g, '""');
	return `"${escaped}"`;
}

/** Write the CSV header if the file doesn't exist yet. */
function initCsv() {
	if (!fs.existsSync(CSV_PATH)) {
		fs.writeFileSync(CSV_PATH, "eml_md5hash;unixtime;from;to;subject\n", "utf8");
	}
}

/** Append one row to mails.csv synchronously (safe for sequential writes). */
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
				// fallback to original
			}
			return match;
		},
	);
}

// ── Filename sanitizer ───────────────────────────────────────────────────────

function escapeFilename(subject: string): string {
	return (
		subject
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Win32 filename restrictions include control characters 0x00-0x1F
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

/**
 * Parse mbox format file and extract individual emails.
 * Mbox format uses "From " lines as message separators.
 */
function* parseMbox(content: string): Generator<string> {
	const lines = content.split(/\r?\n/);
	let currentMessage: string[] = [];
	let inMessage = false;

	for (const line of lines) {
		// Check if this is a "From " separator line
		// The pattern is: From <sender> <date>
		if (line.startsWith("From ") && !inMessage) {
			inMessage = true;
			continue; // Skip the separator line itself
		}

		// Check for next message separator
		if (line.startsWith("From ") && inMessage) {
			// Yield the current message
			if (currentMessage.length > 0) {
				yield currentMessage.join("\n");
			}
			currentMessage = [];
			continue; // Skip the separator line
		}

		if (inMessage) {
			currentMessage.push(line);
		}
	}

	// Yield the last message
	if (currentMessage.length > 0) {
		yield currentMessage.join("\n");
	}
}

// ── File scanner ────────────────────────────────────────────────────────────

/**
 * Recursively find all mbox files (files without .msf extension) in a directory.
 * Only scans within ImapMail and Mail subdirectories.
 */
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
				// Only recurse into mail directories or if we're already in one
				const isMailDir = MAIL_SUBDIRS.includes(entry.name);
				
				if (isMailDir || inMailDir) {
					scan(fullPath, true);
				}
			} else if (entry.isFile() && inMailDir) {
				// Skip .msf files (index files) and other metadata files
				if (!entry.name.endsWith(".msf") && 
					!entry.name.endsWith(".dat") && 
					!entry.name.endsWith(".json") &&
					!entry.name.endsWith(".sqlite") &&
					!entry.name.endsWith(".db") &&
					!entry.name.endsWith(".bin") &&
					!entry.name.endsWith(".lz4") &&
					!entry.name.endsWith(".txt") &&
					!entry.name.startsWith(".")) {
					// Check if it's a regular file (not a directory)
					try {
						const stats = fs.statSync(fullPath);
						if (stats.isFile() && stats.size > 0) {
							mboxFiles.push(fullPath);
						}
					} catch {
						// Skip files we can't read
					}
				}
			}
		}
	}

	scan(dir);
	return mboxFiles;
}

// ── Email extractor ───────────────────────────────────────────────────────────

async function extractEmailsFromMbox(mboxPath: string): Promise<{ total: number; saved: number; errors: number }> {
	const relativePath = path.relative(
		SOURCE_DIRS.find((dir) => mboxPath.startsWith(dir)) || SOURCE_DIRS[0],
		mboxPath,
	);

	commitLine(`\n▸ Processing: ${relativePath}`);

	let total = 0;
	let saved = 0;
	let errors = 0;

	try {
		const content = fs.readFileSync(mboxPath, "utf8");
		
		for (const emailContent of parseMbox(content)) {
			total++;
			
			try {
				// Extract headers (first empty line separates headers from body)
				const headerEndIndex = emailContent.indexOf("\n\n");
				const headersText = headerEndIndex !== -1 
					? emailContent.substring(0, headerEndIndex)
					: emailContent;

				const { unixStamp, subject, from, to } = parseHeaders(headersText);
				
				// Calculate MD5 of the full email content
				const md5 = crypto.createHash("md5").update(emailContent, "utf8").digest("hex");
				const finalPath = path.join(OUTPUT_DIR, `${md5}.eml`);

				if (fs.existsSync(finalPath)) {
					console.log(`  [${relativePath}] ${total} — [dup] ${subject}`);
					continue;
				}

				await fs.promises.writeFile(finalPath, emailContent, "utf8");
				csvAppend(md5, unixStamp, from, to, subject);
				saved++;
				console.log(`  [${relativePath}] ${total} — ${subject}`);
			} catch (err) {
				errors++;
				console.log(`  [${relativePath}] ${total} — [error] ${(err as Error).message}`);
			}
		}
	} catch (err) {
		commitLine(`  ✗ Failed to read ${mboxPath}: ${(err as Error).message}`);
		return { total: 0, saved: 0, errors: 1 };
	}

	commitLine(`  ✓ ${relativePath} — ${saved}/${total} saved, ${errors} errors`);
	return { total, saved, errors };
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
	commitLine(`Output directory: ${OUTPUT_DIR}`);
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	initCsv();

	// Find all mbox files in source directories
	const allMboxFiles: string[] = [];
	for (const sourceDir of SOURCE_DIRS) {
		if (fs.existsSync(sourceDir)) {
			const files = findMboxFiles(sourceDir);
			allMboxFiles.push(...files);
			commitLine(`Found ${files.length} mbox files in ${sourceDir}`);
		} else {
			commitLine(`Directory not found: ${sourceDir}`);
		}
	}

	if (allMboxFiles.length === 0) {
		commitLine("No mbox files found. Exiting.");
		return;
	}

	commitLine(`\nTotal mbox files to process: ${allMboxFiles.length}`);

	const startTime = Date.now();
	let grandTotal = 0;
	let grandSaved = 0;
	let grandErrors = 0;

	// Process each mbox file
	for (const mboxFile of allMboxFiles) {
		const result = await extractEmailsFromMbox(mboxFile);
		grandTotal += result.total;
		grandSaved += result.saved;
		grandErrors += result.errors;
	}

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	commitLine(`\n✔ All done in ${elapsed}s`);
	commitLine(`Total emails: ${grandTotal}`);
	commitLine(`Saved: ${grandSaved}`);
	commitLine(`Errors: ${grandErrors}`);
	commitLine(`Emails saved to: ${OUTPUT_DIR}`);
	commitLine(`CSV index: ${CSV_PATH}`);
}

main().catch((err) => {
	commitLine(`\nFatal error: ${(err as Error).message}`);
	process.exit(1);
});
