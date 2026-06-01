import { db } from "./index";
import { parcels } from "./schema";

async function seed() {
	console.log("Seeding database...");
	try {
		// Check if there are already parcels
		const existing = await db.select().from(parcels).limit(1);
		if (existing.length > 0) {
			console.log("Database already has data. Skipping seed.");
			return;
		}

		await db.insert(parcels).values([
			{
				trackingNumber: "JD000000001",
				courier: "DHL",
				status: "arriving",
				lat: 48.1351,
				lng: 11.582,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				trackingNumber: "1Z999999999",
				courier: "UPS",
				status: "sent",
				lat: 40.7128,
				lng: -74.006,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				trackingNumber: "TBA00000000",
				courier: "Amazon",
				status: "delivered",
				lat: 51.5074,
				lng: -0.1278,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		]);
		console.log("Database seeded successfully!");
	} catch (error) {
		console.error("Error seeding database:", error);
	}
}

seed();
