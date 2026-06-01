import assert from "node:assert";

const BASE_URL = "http://localhost:3000/api/v1";
const GUEST_TOKEN = "guest_secret_token";
const ADMIN_TOKEN = "admin_secret_token";

async function cleanIfExists(trackingNumber: string) {
	const listRes = await fetch(`${BASE_URL}/parcels?token=${GUEST_TOKEN}`);
	if (listRes.ok) {
		const list = await listRes.json();
		const existing = list.find(
			(p: { id: number; trackingNumber: string }) =>
				p.trackingNumber === trackingNumber,
		);
		if (existing) {
			console.log(
				`🧹 CleanUp: Found existing parcel for ${trackingNumber} (ID: ${existing.id}). Deleting...`,
			);
			await fetch(`${BASE_URL}/parcels/${existing.id}?token=${ADMIN_TOKEN}`, {
				method: "DELETE",
			});
		}
	}
}

async function runTests() {
	console.log("📦 Starting Live Tracking Resolution Tests...\n");

	const trackingNumbers = [
		{ number: "00340434694908615482", description: "DHL Tracking" },
		{ number: "H1003660585039901044", description: "Hermes Tracking" },
	];

	for (const item of trackingNumbers) {
		console.log(`\n--- Testing: ${item.description} (${item.number}) ---`);

		// Clean up if left over from previous runs
		await cleanIfExists(item.number);

		// 1. Create the parcel in the database
		console.log(`Step 1: Adding parcel to database...`);
		const addRes = await fetch(`${BASE_URL}/parcels?token=${ADMIN_TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				trackingNumber: item.number,
				status: "ordered",
				courier: "Auto Detect",
			}),
		});

		assert.strictEqual(addRes.status, 201, "Should create parcel in DB");
		const parcel = await addRes.json();
		console.log(`Created Parcel ID: ${parcel.id}`);

		// 2. Trigger live tracking resolution
		console.log(`Step 2: Triggering live tracking update...`);
		const trackRes = await fetch(
			`${BASE_URL}/parcels/${parcel.id}/track?token=${ADMIN_TOKEN}`,
		);

		if (trackRes.status !== 200) {
			const err = await trackRes.json();
			console.error("❌ Tracking resolution failed:", err);
			continue;
		}

		const updatedParcel = await trackRes.json();
		console.log(`Resolved Courier: ${updatedParcel.courier}`);
		console.log(`Resolved Status: ${updatedParcel.status}`);
		console.log(
			`Estimated Delivery: ${updatedParcel.estimatedDeliveryStart || "N/A"}`,
		);

		// 3. Fetch associated events
		console.log(`Step 3: Checking database for events...`);
		const eventsRes = await fetch(
			`${BASE_URL}/parcels/${parcel.id}/events?token=${ADMIN_TOKEN}`,
		);
		assert.strictEqual(
			eventsRes.status,
			200,
			"Should load events successfully",
		);
		const events = await eventsRes.json();
		console.log(`Logged Events in DB: ${events.length}`);

		if (events.length > 0) {
			console.log("Latest 3 Events:");
			events
				.slice(0, 3)
				.forEach(
					(e: {
						timestamp: string;
						location?: string | null;
						description: string;
					}) => {
						console.log(
							` - [${new Date(e.timestamp).toLocaleString()}] (${e.location || "Unknown"}): ${e.description}`,
						);
					},
				);
		} else {
			console.log("⚠️ No events returned/logged.");
		}

		// 4. Verify cascading delete (cleanup)
		console.log(`Step 4: Cleaning up (deleting parcel)...`);
		const deleteRes = await fetch(
			`${BASE_URL}/parcels/${parcel.id}?token=${ADMIN_TOKEN}`,
			{ method: "DELETE" },
		);
		assert.strictEqual(deleteRes.status, 200, "Should delete parcel");
		console.log("✅ Cleaned up successfully.");
	}

	console.log("\n🎉 Live Tracking Resolution Tests Completed!");
}

runTests().catch((err) => {
	console.error("\n❌ Tests failed:", err);
	process.exit(1);
});
