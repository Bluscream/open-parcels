const BASE_URL = "http://localhost:3000/api/v1";
const GUEST_TOKEN = "guest_secret_token";
const ADMIN_TOKEN = "admin_secret_token";

async function seedRealParcels() {
	console.log("📦 Seeding real parcels into DB...");

	const parcelsToSeed = [
		{ number: "00340434694908615482", courier: "DHL" },
		{ number: "H1003660585039901044", courier: "Hermes" },
	];

	// 1. Fetch current parcels to check for duplicates
	const listRes = await fetch(`${BASE_URL}/parcels?token=${GUEST_TOKEN}`);
	const list = listRes.ok ? await listRes.json() : [];

	for (const item of parcelsToSeed) {
		let parcel = list.find(
			(p: { id: number; trackingNumber: string }) =>
				p.trackingNumber === item.number,
		);

		if (!parcel) {
			console.log(`Adding ${item.courier} parcel ${item.number}...`);
			const createRes = await fetch(
				`${BASE_URL}/parcels?token=${ADMIN_TOKEN}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						trackingNumber: item.number,
						status: "ordered",
						courier: item.courier,
					}),
				},
			);
			parcel = await createRes.json();
		} else {
			console.log(`Parcel ${item.number} already exists with ID: ${parcel.id}`);
		}

		// 2. Trigger tracking update
		console.log(`Triggering tracking update for Parcel ID: ${parcel.id}...`);
		const trackRes = await fetch(
			`${BASE_URL}/parcels/${parcel.id}/track?token=${ADMIN_TOKEN}`,
		);
		if (trackRes.ok) {
			const updated = await trackRes.json();
			console.log(
				`✅ Successfully tracked! Status: ${updated.status}, Courier: ${updated.courier}`,
			);
		} else {
			console.log(`❌ Failed to track parcel ${parcel.id}`);
		}
	}

	console.log("\n🎉 Finished seeding and tracking real parcels!");
}

seedRealParcels().catch(console.error);
