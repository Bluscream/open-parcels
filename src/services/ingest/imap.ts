import { eq } from "drizzle-orm";
import imaps from "imap-simple";
import { simpleParser } from "mailparser";
import { db } from "../../db";
import { credentials } from "../../db/schema";
import { EmailParser, TrackingParser } from "./parser";

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

	// TODO: Decrypt credentials
	const configStr = imapCreds[0].encryptedData; // Assuming it's simple JSON for now
	let config: {
		user?: string;
		password?: string;
		host?: string;
		port?: number;
		tls?: boolean;
	};
	try {
		config = JSON.parse(configStr);
	} catch (_e) {
		console.error("Failed to parse IMAP credentials");
		return;
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
					// TODO: Save to DB and emit Home Assistant Event
				}
			}
		}

		connection.end();
	} catch (error) {
		console.error("IMAP Polling Error:", error);
	}
}
