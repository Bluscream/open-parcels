import dotenv from "dotenv";
dotenv.config();

import { trackAndUpdateParcel } from "../src/services/tracking/aggregator";
import { db } from "../src/db";
import { parcels, parcelEvents, credentials } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function main() {
	const trackingNumber = "DE5525979947";
	const found = await db.select().from(parcels).where(eq(parcels.trackingNumber, trackingNumber)).limit(1);
	if (found.length === 0) {
		console.error("Parcel not found in DB! Please create/link it first.");
		return;
	}
	const parcel = found[0];
	console.log("Found parcel:", parcel);

	const decrypted = await db
		.select()
		.from(credentials)
		.where(eq(credentials.service, "Amazon"))
		.limit(1);
	if (decrypted.length > 0) {
		const { decryptCredential } = require("../src/utils/crypto");
		const creds = JSON.parse(decryptCredential(decrypted[0].encryptedData));
		console.log("--- DB Credentials Debug ---");
		console.log("Service Name:", decrypted[0].service);
		console.log("Keys available in credentials object:", Object.keys(creds));
		console.log("Has username/email?", !!creds.username || !!creds.email);
		console.log("Has password?", !!creds.password);
		console.log("Has otpSecret?", !!creds.otpSecret);
		console.log("Provided password matches DB?", creds.password === "h#qco@5hY!CK05T&wlYOPzd7Enw%jC8T");
		console.log("Database password length:", creds.password ? creds.password.length : 0);
		console.log("----------------------------");
	} else {
		console.log("⚠️ No Amazon credentials records found in DB!");
	}

	console.log("Running trackAndUpdateParcel for parcel ID:", parcel.id);
	
	const success = await trackAndUpdateParcel(parcel.id);
	console.log("trackAndUpdateParcel returned:", success);

	const updated = await db.select().from(parcels).where(eq(parcels.id, parcel.id)).limit(1);
	console.log("Updated parcel:", updated[0]);

	const events = await db.select().from(parcelEvents).where(eq(parcelEvents.parcelId, parcel.id));
	console.log("Logged events:", events);
}

main().catch(console.error);
