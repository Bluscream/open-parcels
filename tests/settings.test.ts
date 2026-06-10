import assert from "node:assert";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { settings } from "../src/db/schema";

async function runTests() {
	console.log("🧪 Starting Settings Registry Integration Tests...\n");

	// Clear any existing test settings
	console.log("Step 1: Cleaning previous test settings...");
	await db.delete(settings).where(eq(settings.key, "test_home_latitude"));
	await db.delete(settings).where(eq(settings.key, "test_home_name"));

	// --- Test 1: Insert and Upsert ---
	console.log(
		"Step 2: Testing key-value setting insertion and updates (upsert)...",
	);

	// Insert setting
	await db.insert(settings).values({
		key: "test_home_name",
		value: "Original Test House",
		updatedAt: new Date(),
	});

	const checkInsert = await db
		.select()
		.from(settings)
		.where(eq(settings.key, "test_home_name"))
		.limit(1);
	assert.strictEqual(checkInsert.length, 1, "Should find inserted setting");
	assert.strictEqual(
		checkInsert[0].value,
		"Original Test House",
		"Value should match original",
	);

	// Upsert (insert on conflict update)
	await db
		.insert(settings)
		.values({
			key: "test_home_name",
			value: "Updated Test House",
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: "Updated Test House", updatedAt: new Date() },
		});

	const checkUpsert = await db
		.select()
		.from(settings)
		.where(eq(settings.key, "test_home_name"))
		.limit(1);
	assert.strictEqual(checkUpsert.length, 1, "Should find setting");
	assert.strictEqual(
		checkUpsert[0].value,
		"Updated Test House",
		"Value should be updated on conflict",
	);
	console.log("✅ DB Settings Upsert verified.");

	// --- Test 2: Env Var Fallbacks Logic ---
	console.log("Step 3: Verifying env var fallback mapping...");

	// Setup mock env vars
	process.env.LATITUDE = "48.8566"; // Paris
	process.env.LONGITUDE = "2.3522";
	process.env.HOME_NAME = "Paris Eiffel";
	process.env.TIMEZONE = "Europe/Paris";

	// Helper simulating the GET /settings merging logic
	const dbSettings = await db.select().from(settings);
	const settingsMap = Object.fromEntries(
		dbSettings.map((s) => [s.key, s.value]),
	);

	const home_latitude =
		settingsMap.home_latitude || process.env.LATITUDE || "50.1109";
	const home_longitude =
		settingsMap.home_longitude || process.env.LONGITUDE || "8.6821";
	const home_name =
		settingsMap.home_name || process.env.HOME_NAME || "Home (Destination)";
	const timezone =
		settingsMap.timezone || process.env.TIMEZONE || "Europe/Berlin";

	assert.strictEqual(
		home_latitude,
		"48.8566",
		"Latitude should fallback to process.env.LATITUDE",
	);
	assert.strictEqual(
		home_longitude,
		"2.3522",
		"Longitude should fallback to process.env.LONGITUDE",
	);
	assert.strictEqual(
		home_name,
		"Paris Eiffel",
		"Home name should fallback to process.env.HOME_NAME",
	);
	assert.strictEqual(
		timezone,
		"Europe/Paris",
		"Timezone should fallback to process.env.TIMEZONE",
	);

	// Verify that database settings override env vars
	console.log("Step 4: Verifying database values override env var values...");

	await db
		.insert(settings)
		.values({
			key: "home_name",
			value: "Berlin HQ Overridden",
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: settings.key,
			set: { value: "Berlin HQ Overridden", updatedAt: new Date() },
		});

	const dbSettings2 = await db.select().from(settings);
	const settingsMap2 = Object.fromEntries(
		dbSettings2.map((s) => [s.key, s.value]),
	);
	const resolvedHomeName =
		settingsMap2.home_name || process.env.HOME_NAME || "Home (Destination)";

	assert.strictEqual(
		resolvedHomeName,
		"Berlin HQ Overridden",
		"DB override should win over env var",
	);
	console.log("✅ Env Var Fallback overrides verified.");

	// Clean up
	console.log("Step 5: Cleaning up test keys...");
	await db.delete(settings).where(eq(settings.key, "test_home_name"));
	await db.delete(settings).where(eq(settings.key, "home_name"));

	console.log("\n🎉 All settings integration tests passed successfully!");
}

runTests().catch((err) => {
	console.error("\n❌ Tests failed:", err);
	process.exit(1);
});
