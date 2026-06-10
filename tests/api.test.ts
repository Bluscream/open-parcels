import assert from "node:assert";

const BASE_URL = "http://localhost:3000/api/v1";
const GUEST_TOKEN = "guest_secret_token";
const ADMIN_TOKEN = "admin_secret_token";

async function runTests() {
	console.log("🚀 Starting API Integration Tests...\n");

	// Test 1: GET /parcels without token -> should be 401
	console.log("Test 1: GET /parcels without token");
	const res1 = await fetch(`${BASE_URL}/parcels`);
	assert.strictEqual(res1.status, 401, "Should return 401 without token");
	const body1 = await res1.json();
	assert.deepStrictEqual(body1, { error: "Unauthorized: Missing token" });
	console.log("✅ Passed");

	// Test 2: GET /parcels with invalid token -> should be 403
	console.log("Test 2: GET /parcels with invalid token");
	const res2 = await fetch(`${BASE_URL}/parcels?token=wrong_token`);
	assert.strictEqual(res2.status, 403, "Should return 403 with invalid token");
	console.log("✅ Passed");

	// Test 3: GET /parcels with guest token -> should be 200
	console.log("Test 3: GET /parcels with guest token");
	const res3 = await fetch(`${BASE_URL}/parcels?token=${GUEST_TOKEN}`);
	assert.strictEqual(res3.status, 200, "Should return 200 with guest token");
	const parcels = await res3.json();
	assert.ok(Array.isArray(parcels), "Parcels should be an array");
	console.log(`✅ Passed (Found ${parcels.length} parcels)`);

	// Test 4: POST /parcels with guest token -> should be 403 (write blocked)
	console.log("Test 4: POST /parcels with guest token (write block)");
	const res4 = await fetch(`${BASE_URL}/parcels?token=${GUEST_TOKEN}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ trackingNumber: "TEST12345", status: "ordered" }),
	});
	assert.strictEqual(res4.status, 403, "Should block guest write with 403");
	console.log("✅ Passed");

	// Test 5: POST /parcels with admin token -> should be 201 (success)
	console.log("Test 5: POST /parcels with admin token");
	const res5 = await fetch(`${BASE_URL}/parcels?token=${ADMIN_TOKEN}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			trackingNumber: "TEST12345",
			courier: "FedEx",
			status: "sent",
			lat: 34.0522,
			lng: -118.2437,
		}),
	});
	assert.strictEqual(res5.status, 201, "Should successfully create parcel");
	const newParcel = await res5.json();
	assert.strictEqual(newParcel.trackingNumber, "TEST12345");
	assert.strictEqual(newParcel.courier, "FedEx");
	assert.strictEqual(newParcel.status, "sent");
	assert.strictEqual(newParcel.lat, 34.0522);
	console.log(`✅ Passed (Created parcel ID: ${newParcel.id})`);

	// Test 6: PATCH /parcels/:id -> should update details
	console.log(`Test 6: PATCH /parcels/${newParcel.id} to update status`);
	const res6 = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}?token=${ADMIN_TOKEN}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "delivered", courier: "FedEx Express" }),
		},
	);
	assert.strictEqual(res6.status, 200, "Should update parcel");
	const updatedParcel = await res6.json();
	assert.strictEqual(updatedParcel.status, "delivered");
	assert.strictEqual(updatedParcel.courier, "FedEx Express");
	console.log("✅ Passed");

	// Test 7: POST /parcels/:id/events -> add event
	console.log(`Test 7: POST /parcels/${newParcel.id}/events`);
	const res7 = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}/events?token=${ADMIN_TOKEN}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				location: "Los Angeles Hub",
				description: "Delivered at front door",
			}),
		},
	);
	assert.strictEqual(res7.status, 201, "Should create event");
	const event = await res7.json();
	assert.strictEqual(event.description, "Delivered at front door");
	assert.strictEqual(event.location, "Los Angeles Hub");
	console.log(`✅ Passed (Created event ID: ${event.id})`);

	// Test 8: GET /parcels/:id/events -> list events
	console.log(`Test 8: GET /parcels/${newParcel.id}/events`);
	const res8 = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}/events?token=${GUEST_TOKEN}`,
	);
	assert.strictEqual(res8.status, 200, "Should return 200");
	const events = await res8.json();
	assert.strictEqual(events.length, 1, "Should return exactly 1 event");
	assert.strictEqual(events[0].id, event.id);
	console.log("✅ Passed");

	// Test 9: POST /orders -> create order
	console.log("Test 9: POST /orders");
	const res9 = await fetch(`${BASE_URL}/orders?token=${ADMIN_TOKEN}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			source: "eBay",
			orderNumber: "EB-99887766",
			status: "processing",
		}),
	});
	assert.strictEqual(res9.status, 201, "Should create order");
	const newOrder = await res9.json();
	assert.strictEqual(newOrder.source, "eBay");
	assert.strictEqual(newOrder.orderNumber, "EB-99887766");
	console.log(`✅ Passed (Created order ID: ${newOrder.id})`);

	// Test 10: GET /orders -> verify listing
	console.log("Test 10: GET /orders");
	const res10 = await fetch(`${BASE_URL}/orders?token=${GUEST_TOKEN}`);
	assert.strictEqual(res10.status, 200, "Should return 200");
	const ordersList = await res10.json();
	const found = ordersList.some((o: { id: number }) => o.id === newOrder.id);
	assert.ok(found, "Should find the newly created order in list");
	console.log("✅ Passed");

	// Test 11: DELETE /orders/:id -> delete order
	console.log(`Test 11: DELETE /orders/${newOrder.id}`);
	const res11 = await fetch(
		`${BASE_URL}/orders/${newOrder.id}?token=${ADMIN_TOKEN}`,
		{
			method: "DELETE",
		},
	);
	assert.strictEqual(res11.status, 200, "Should delete order");
	console.log("✅ Passed");

	// Test 12: DELETE /parcels/:id -> delete parcel
	console.log(`Test 12: DELETE /parcels/${newParcel.id}`);
	const res12 = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}?token=${ADMIN_TOKEN}`,
		{
			method: "DELETE",
		},
	);
	assert.strictEqual(res12.status, 200, "Should delete parcel");

	// Verify it is gone
	const res12Verify = await fetch(`${BASE_URL}/parcels?token=${GUEST_TOKEN}`);
	const finalParcels = await res12Verify.json();
	const stillExists = finalParcels.some(
		(p: { id: number }) => p.id === newParcel.id,
	);
	assert.ok(!stillExists, "Parcel should not be in the list anymore");

	// Verify associated events are also deleted
	const res12VerifyEvents = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}/events?token=${GUEST_TOKEN}`,
	);
	const finalEvents = await res12VerifyEvents.json();
	assert.strictEqual(
		finalEvents.length,
		0,
		"Associated events should be cleaned up",
	);
	console.log("✅ Passed");

	console.log("\n🎉 All API Integration Tests Passed Successfully!");
}

runTests().catch((err) => {
	console.error("\n❌ Test Suite Failed:", err);
	process.exit(1);
});
