import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import imaps from "imap-simple";

const CONFIG_PATH = "/run/media/system/Data/Projects/nodejs/open-parcels/imap-config.json";
const OUTPUT_DIR = "/var/mnt/nas_nfs/backups/Timo/mails";
const CSV_PATH = path.join(OUTPUT_DIR, "mails.csv");
const BATCH_SIZE = 50;

function commitLine(line: string) {
	console.log(line);
}

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

function formatImapDate(date: Date): string {
	const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
	const day = date.getDate().toString().padStart(2, "0");
	const month = months[date.getMonth()];
	const year = date.getFullYear();
	return `${day}-${month}-${year}`;
}

function getCutoffTimestamp(): number {
	if (!fs.existsSync(CSV_PATH)) {
		commitLine(`Warning: CSV file not found at ${CSV_PATH}. Using timestamp 0.`);
		return 0;
	}
	try {
		const content = fs.readFileSync(CSV_PATH, "utf8");
		const lines = content.split(/\r?\n/);
		let maxTs = 0;
		for (const line of lines) {
			if (!line.trim()) continue;
			const parts = line.split(";");
			if (parts.length >= 2) {
				const ts = parseInt(parts[1], 10);
				if (!Number.isNaN(ts) && ts > maxTs) {
					maxTs = ts;
				}
			}
		}
		return maxTs;
	} catch (err) {
		commitLine(`Error reading CSV file: ${(err as Error).message}. Using timestamp 0.`);
		return 0;
	}
}

async function downloadAccountEmails(config: any, cutoffTimestamp: number) {
	const user: string = config.user;
	commitLine(`\n► Connecting to IMAP for ${user}...`);

	const imapConfig = {
		imap: {
			user,
			password: (config.password as string).replace(/\s/g, ""),
			host: (config.host as string) || "imap.gmail.com",
			port: (config.port as number) || 993,
			tls: config.tls !== false,
			authTimeout: 30000,
			connTimeout: 30000,
			tlsOptions: {
				rejectUnauthorized: false,
			},
		},
	};

	let connection: imaps.ImapSimple;
	try {
		connection = await imaps.connect(imapConfig);
	} catch (err) {
		commitLine(`✗ Failed to connect to ${user}: ${(err as Error).message}`);
		return;
	}
	commitLine(`✓ Connected to ${user}`);

	let accountTotal = 0;
	let accountSaved = 0;
	let accountSkipped = 0;
	let accountErrors = 0;

	try {
		const boxes = await connection.getBoxes();
		const folders: string[] = [];

		function collectFolders(box: any, prefix = "") {
			for (const name of Object.keys(box)) {
				const fullPath = prefix
					? `${prefix}${connection.imap.delimiter}${name}`
					: name;
				const currentBox = box[name];
				if (!currentBox.attribs?.includes("NOSELECT")) {
					// Skip Trash, Junk, Spam folders to avoid unnecessary downloads
					const lowerName = name.toLowerCase();
					if (!lowerName.includes("trash") && !lowerName.includes("junk") && !lowerName.includes("spam") && !lowerName.includes("bin")) {
						folders.push(fullPath);
					}
				}
				if (currentBox.children) {
					collectFolders(currentBox.children, fullPath);
				}
			}
		}

		collectFolders(boxes);
		commitLine(`  Found active folders: ${folders.join(", ")}`);

		// Start searching from 1 day before cutoff to handle timezone mismatches safely
		const searchDate = new Date((cutoffTimestamp - 24 * 60 * 60) * 1000);
		const imapDateStr = formatImapDate(searchDate);

		for (const folder of folders) {
			commitLine(`\n  ▸ Opening [${folder}]...`);
			try {
				await connection.openBox(folder);
			} catch (err) {
				commitLine(`  ✗ Could not open [${folder}]: ${(err as Error).message}`);
				continue;
			}

			// Search with SINCE date filter
			const searchCriteria = [["SINCE", imapDateStr]];
			const searchOptions = {
				bodies: [],
				struct: false,
			};

			let uidMessages: any[];
			try {
				uidMessages = await connection.search(searchCriteria, searchOptions);
			} catch (err) {
				commitLine(`  ✗ Search failed in [${folder}]: ${(err as Error).message}`);
				continue;
			}

			const total = uidMessages.length;
			if (total === 0) {
				commitLine(`  ○ [${folder}] has no messages since ${imapDateStr}, skipping.`);
				continue;
			}

			commitLine(`  ● [${folder}] — ${total} messages to check`);
			accountTotal += total;

			const uids = uidMessages.map((m) => m.attributes.uid as number);

			for (let i = 0; i < uids.length; i += BATCH_SIZE) {
				const batchUids = uids.slice(i, i + BATCH_SIZE);

				const batchMessages = await new Promise<any[]>((resolve, reject) => {
					const collected: any[] = [];
					const f = connection.imap.fetch(batchUids as any, {
						bodies: ["HEADER", ""],
						struct: true,
					});
					f.on("message", (msg: any) => {
						const entry: any = { parts: [], attributes: {} };
						msg.on("body", (stream: any, info: any) => {
							const chunks: Buffer[] = [];
							stream.on("data", (chunk: Buffer) => chunks.push(chunk));
							stream.once("end", () => {
								entry.parts.push({
									which: info.which,
									body: Buffer.concat(chunks).toString("utf8"),
								});
							});
						});
						msg.once("attributes", (attrs: any) => { entry.attributes = attrs; });
						msg.once("end", () => collected.push(entry));
					});
					f.once("error", reject);
					f.once("end", () => resolve(collected));
				});

				for (const msg of batchMessages) {
					try {
						const headerPart = msg.parts.find((p: any) => p.which === "HEADER");
						const fullPart = msg.parts.find((p: any) => p.which === "");

						if (!fullPart) {
							accountErrors++;
							continue;
						}

						const headersText = headerPart ? headerPart.body : "";
						const { unixStamp, subject, from, to } = parseHeaders(headersText);

						if (unixStamp <= cutoffTimestamp) {
							accountSkipped++;
							continue;
						}

						const rawBody: string = fullPart.body;
						const md5 = crypto.createHash("md5").update(rawBody, "utf8").digest("hex");
						const finalPath = path.join(OUTPUT_DIR, `${md5}.eml`);

						if (fs.existsSync(finalPath)) {
							accountSkipped++;
							continue;
						}

						await fs.promises.writeFile(finalPath, rawBody, "utf8");
						csvAppend(md5, unixStamp, from, to, subject);
						accountSaved++;
						console.log(`  [${user} | ${folder}] Saved: ${subject} (${new Date(unixStamp * 1000).toLocaleString()})`);
					} catch (err) {
						accountErrors++;
						console.log(`  [${user} | ${folder}] Error: ${(err as Error).message}`);
					}
				}
			}
		}
	} finally {
		connection.end();
	}

	commitLine(`\n✓ ${user} complete: ${accountSaved} saved, ${accountSkipped} skipped, ${accountErrors} errors`);
}

async function main() {
	const cutoffTimestamp = getCutoffTimestamp();
	commitLine(`Cutoff timestamp: ${cutoffTimestamp} (${new Date(cutoffTimestamp * 1000).toLocaleString()})`);

	if (!fs.existsSync(CONFIG_PATH)) {
		commitLine(`Fatal: Config file not found at ${CONFIG_PATH}`);
		process.exit(1);
	}

	const accounts = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	// For this scrape run, we process any account configured that has a valid password
	const activeAccounts = accounts.filter(
		(a: any) => a.password && !a.password.includes("app-password-here")
	);

	if (activeAccounts.length === 0) {
		commitLine("No active accounts to scrape. Check imap-config.json credentials.");
		return;
	}

	commitLine(`Processing accounts: ${activeAccounts.map((a: any) => a.user).join(", ")}`);

	const startTime = Date.now();
	await Promise.allSettled(
		activeAccounts.map((account: any) =>
			downloadAccountEmails(account, cutoffTimestamp).catch((err: Error) =>
				commitLine(`Error processing ${account.user}: ${err.message}`)
			)
		)
	);

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	commitLine(`\n✔ All done in ${elapsed}s`);
}

main().catch((err) => {
	commitLine(`\nFatal error: ${(err as Error).message}`);
	process.exit(1);
});
