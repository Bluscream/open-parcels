import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const PROFILE_DIR =
	"C:\\Users\\Bluscream\\AppData\\Roaming\\Thunderbird\\Profiles\\4qd22y6j.default-release";
const OUTPUT_DIR = path.join(process.env.TEMP || os.tmpdir(), "mails");

// RFC 2047 MIME Header Decoder
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
						(_: string, hex: string) => {
							return String.fromCharCode(parseInt(hex, 16));
						},
					);
					return Buffer.from(hexDecoded, "binary").toString(
						charset.toLowerCase() === "utf-8" ? "utf8" : "latin1",
					);
				}
			} catch (_e) {
				// fallback to original if decoding fails
			}
			return match;
		},
	);
}

// Clean subject for Windows filenames
function escapeFilename(subject: string): string {
	return (
		subject
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Win32 filename restrictions include control characters 0x00-0x1F
			.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_") // Replace invalid chars
			.replace(/\s+/g, "_") // Replace spaces
			.replace(/__+/g, "_") // Collapse multiple underscores
			.trim()
			.substring(0, 120)
	); // Limit length
}

// Find mbox files recursively
function findMboxFiles(dir: string): string[] {
	let results: string[] = [];
	const list = fs.readdirSync(dir);
	for (const file of list) {
		const filePath = path.join(dir, file);
		const stat = fs.statSync(filePath);
		if (stat?.isDirectory()) {
			if (file !== "node_modules" && file !== "dist") {
				results = results.concat(findMboxFiles(filePath));
			}
		} else {
			// Mbox files have no extension and are > 0 bytes
			const ext = path.extname(file);
			if (
				ext === "" &&
				stat.size > 0 &&
				(filePath.includes("ImapMail") || filePath.includes("Mail"))
			) {
				results.push(filePath);
			}
		}
	}
	return results;
}

// Parse Subject and Date headers from email content
function parseHeaders(emailContent: string): {
	unixStamp: number;
	subjectEscaped: string;
} {
	let subject = "no_subject";
	let dateStr = "";

	// Extract headers block (everything before the first empty line)
	const doubleNewlineIdx = emailContent.search(/\r?\n\r?\n/);
	const headersBlock =
		doubleNewlineIdx !== -1
			? emailContent.substring(0, doubleNewlineIdx)
			: emailContent;

	// Extract Subject (handles folded headers)
	const subjectMatch = headersBlock.match(
		/^Subject:\s*([^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*)/im,
	);
	if (subjectMatch) {
		subject = subjectMatch[1].replace(/\r?\n[ \t]+/g, " ").trim();
		subject = decodeMimeHeader(subject);
	}

	// Extract Date
	const dateMatch = headersBlock.match(/^Date:\s*([^\r\n]+)/im);
	if (dateMatch) {
		dateStr = dateMatch[1].trim();
	}

	let unixStamp = Math.floor(Date.now() / 1000);
	if (dateStr) {
		const parsedDate = Date.parse(dateStr);
		if (!Number.isNaN(parsedDate)) {
			unixStamp = Math.floor(parsedDate / 1000);
		}
	}

	return {
		unixStamp,
		subjectEscaped: escapeFilename(subject || "no_subject"),
	};
}

async function processMbox(mboxPath: string) {
	console.log(`Processing mbox: ${mboxPath}`);
	const fileStream = fs.createReadStream(mboxPath);
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity,
	});

	let currentEmailLines: string[] = [];
	let isFirstLine = true;
	let emailCount = 0;

	for await (const line of rl) {
		// Start of a new email: line starts with "From " and either it's the first line or preceding line was empty (implicitly)
		// Betterbird/Thunderbird mbox emails start with a "From - <date>" or "From sender@domain <date>" line.
		if (
			line.startsWith("From ") &&
			(isFirstLine ||
				currentEmailLines.length === 0 ||
				currentEmailLines[currentEmailLines.length - 1] === "")
		) {
			if (currentEmailLines.length > 0) {
				// Remove the trailing empty line if it was accumulated
				if (currentEmailLines[currentEmailLines.length - 1] === "") {
					currentEmailLines.pop();
				}
				// Save previous email
				await saveEmail(currentEmailLines.join("\n"));
				emailCount++;
			}
			currentEmailLines = [];
		} else {
			currentEmailLines.push(line);
		}
		isFirstLine = false;
	}

	// Save the last email in the file
	if (currentEmailLines.length > 0) {
		await saveEmail(currentEmailLines.join("\n"));
		emailCount++;
	}

	console.log(`Finished ${mboxPath}: Extracted ${emailCount} emails.`);
}

async function saveEmail(content: string) {
	const { unixStamp, subjectEscaped } = parseHeaders(content);
	const filename = `${unixStamp}_${subjectEscaped}.eml`;
	const destPath = path.join(OUTPUT_DIR, filename);

	// In case of filename collisions, append counter
	let finalPath = destPath;
	let counter = 1;
	while (fs.existsSync(finalPath)) {
		finalPath = path.join(
			OUTPUT_DIR,
			`${unixStamp}_${subjectEscaped}_${counter}.eml`,
		);
		counter++;
	}

	await fs.promises.writeFile(finalPath, content, "utf8");
}

async function main() {
	console.log(`Creating output directory: ${OUTPUT_DIR}`);
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });

	const mboxFiles = findMboxFiles(PROFILE_DIR);
	console.log(`Found ${mboxFiles.length} mbox files to process.`);

	for (const mbox of mboxFiles) {
		try {
			await processMbox(mbox);
		} catch (err) {
			console.error(`Error processing ${mbox}:`, err);
		}
	}

	console.log(`All emails successfully extracted to: ${OUTPUT_DIR}`);
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
