import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import imaps from "imap-simple";

const CONFIG_PATH = path.join(process.cwd(), "imap-config.json");
const OUTPUT_DIR = path.join(process.env.TEMP || os.tmpdir(), "mails");
const CSV_PATH = path.join(OUTPUT_DIR, "mails.csv");
const BATCH_SIZE = 50;

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

// ── Per-account downloader ───────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: config is an arbitrary account details object
async function downloadAccountEmails(config: any) {
	const user: string = config.user;
	commitLine(`\n► Connecting to IMAP for ${user}...`);

	const imapConfig = {
		imap: {
			user,
			// Strip spaces from app passwords (Google displays them with spaces)
			password: (config.password as string).replace(/\s/g, ""),
			host: (config.host as string) || "imap.gmail.com",
			port: (config.port as number) || 993,
			tls: config.tls !== false,
			authTimeout: 30000,
			connTimeout: 30000,
			tlsOptions: {
				// Accept self-signed / intercepted certs (common with ISP proxies)
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
	let accountDone = 0;
	let accountErrors = 0;

	try {
		const boxes = await connection.getBoxes();
		const folders: string[] = [];

		// biome-ignore lint/suspicious/noExplicitAny: IMAP folder structure box is deeply nested and generic
		function collectFolders(box: any, prefix = "") {
			for (const name of Object.keys(box)) {
				const fullPath = prefix
					? `${prefix}${connection.imap.delimiter}${name}`
					: name;
				const currentBox = box[name];
				if (!currentBox.attribs?.includes("NOSELECT")) {
					folders.push(fullPath);
				}
				if (currentBox.children) {
					collectFolders(currentBox.children, fullPath);
				}
			}
		}

		collectFolders(boxes);
		commitLine(`  Found ${folders.length} folders: ${folders.join(", ")}`);

		for (const folder of folders) {
			commitLine(`\n  ▸ Opening [${folder}]...`);
			try {
				await connection.openBox(folder);
			} catch (err) {
				commitLine(`  ✗ Could not open [${folder}]: ${(err as Error).message}`);
				continue;
			}

			// ── Phase 1: get UIDs only — no body download, returns immediately ──────
			const uidMessages = await connection.search(["ALL"], {
				bodies: [],
				struct: false,
			});

			const total = uidMessages.length;
			accountTotal += total;

			if (total === 0) {
				commitLine(`  ○ [${folder}] is empty, skipping.`);
				continue;
			}

			commitLine(`  ● [${folder}] — ${total} messages`);

			let folderDone = 0;
			let folderErrors = 0;

			const uids = uidMessages.map((m) => m.attributes.uid as number);

			// ── Phase 2: fetch bodies in small batches via raw streaming IMAP ────
			for (let i = 0; i < uids.length; i += BATCH_SIZE) {
				const batchUids = uids.slice(i, i + BATCH_SIZE);

				// Wrap the raw imap streaming fetch in a Promise
				// biome-ignore lint/suspicious/noExplicitAny: raw imap module
				const batchMessages = await new Promise<any[]>((resolve, reject) => {
					// biome-ignore lint/suspicious/noExplicitAny: raw imap module
					const collected: any[] = [];
					const f = connection.imap.fetch(batchUids as any, {
						bodies: ["HEADER", ""],
						struct: true,
					});
					// biome-ignore lint/suspicious/noExplicitAny: raw imap module
					f.on("message", (msg: any) => {
						// biome-ignore lint/suspicious/noExplicitAny: raw imap module
						const entry: any = { parts: [], attributes: {} };
						// biome-ignore lint/suspicious/noExplicitAny: raw imap module
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
						// biome-ignore lint/suspicious/noExplicitAny: raw imap module
						msg.once("attributes", (attrs: any) => { entry.attributes = attrs; });
						msg.once("end", () => collected.push(entry));
					});
					f.once("error", reject);
					f.once("end", () => resolve(collected));
				});

				for (const msg of batchMessages) {
					try {
						// biome-ignore lint/suspicious/noExplicitAny: raw imap module
						const headerPart = msg.parts.find((p: any) => p.which === "HEADER");
						// biome-ignore lint/suspicious/noExplicitAny: raw imap module
						const fullPart = msg.parts.find((p: any) => p.which === "");

						if (!fullPart) {
							folderDone++;
							accountDone++;
							continue;
						}

						const headersText = headerPart ? headerPart.body : "";
						const { unixStamp, subject, from, to } = parseHeaders(headersText);
						const cleanUser = user.split("@")[0];
						const rawBody: string = fullPart.body;
						const md5 = crypto.createHash("md5").update(rawBody, "utf8").digest("hex");
						const finalPath = path.join(OUTPUT_DIR, `${md5}.eml`);

						folderDone++;
						accountDone++;

						if (fs.existsSync(finalPath)) {
							console.log(`  [${cleanUser} | ${folder}] ${folderDone}/${total} — [dup] ${subject}`);
							continue;
						}

						await fs.promises.writeFile(finalPath, rawBody, "utf8");
						csvAppend(md5, unixStamp, from, to, subject);
						console.log(`  [${cleanUser} | ${folder}] ${folderDone}/${total} — ${subject}`);
					} catch (_e) {
						folderErrors++;
						accountErrors++;
						folderDone++;
						accountDone++;
					}
				}
			}

			commitLine(
				`  ✓ [${folder}] done — ${folderDone - folderErrors} saved, ${folderErrors} errors`,
			);
		}
	} finally {
		connection.end();
	}

	commitLine(
		`\n✓ ${user} complete — ${accountDone - accountErrors}/${accountTotal} saved, ${accountErrors} errors`,
	);
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
	if (!fs.existsSync(CONFIG_PATH)) {
		const template = [
			{
				user: "example@gmail.com",
				password: "google-app-password-here", // https://myaccount.google.com/apppasswords
				host: "imap.gmail.com",
				port: 993,
				tls: true,
			}
		];
		fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2), "utf8");
		commitLine(`[IMPORTANT] Created config template at: ${CONFIG_PATH}`);
		commitLine(
			"Edit the file and enter your Google App Passwords, then run again.",
		);
		return;
	}

	commitLine(`Output directory: ${OUTPUT_DIR}`);
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	initCsv();

	const accounts = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	const startTime = Date.now();

	const activeAccounts = accounts.filter(
		// biome-ignore lint/suspicious/noExplicitAny: config is arbitrary
		(a: any) => !a.disabled && !(a.password as string).includes("app-password-here"),
	);
	// biome-ignore lint/suspicious/noExplicitAny: config is arbitrary
	const skipped = accounts.filter((a: any) => a.disabled || (a.password as string).includes("app-password-here"));
	for (const a of skipped) commitLine(`Skipping ${a.disabled ? "disabled" : "unconfigured"} account: ${a.user}`);

	await Promise.allSettled(
		// biome-ignore lint/suspicious/noExplicitAny: config is arbitrary
		activeAccounts.map((account: any) =>
			downloadAccountEmails(account).catch((err: Error) =>
				commitLine(`Error processing ${account.user}: ${err.message}`),
			),
		),
	);

	const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
	commitLine(`\n✔ All done in ${elapsed}s — emails saved to: ${OUTPUT_DIR}`);
}

main().catch((err) => {
	commitLine(`\nFatal error: ${(err as Error).message}`);
	process.exit(1);
});
