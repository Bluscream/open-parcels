import assert from "node:assert";

const BASE_URL = "http://localhost:3000/api/v1";
const ADMIN_TOKEN = "admin_secret_token";

async function runTests() {
	console.log("🚀 Starting API Integration Tests...\n");

	// Test 1: GET /parcels without token -> should succeed (200) in simplified auth
	console.log("Test 1: GET /parcels without token");
	const res1 = await fetch(`${BASE_URL}/parcels`);
	assert.strictEqual(res1.status, 200, "GET should return 200 without token");
	const parcels1 = await res1.json();
	assert.ok(Array.isArray(parcels1), "Parcels should be an array");
	console.log("✅ Passed");

	// Test 2: GET /parcels with invalid token -> should also succeed (200) because GET is public
	console.log("Test 2: GET /parcels with invalid token");
	const res2 = await fetch(`${BASE_URL}/parcels?token=wrong_token`);
	assert.strictEqual(res2.status, 200, "GET should return 200 even with invalid token");
	console.log("✅ Passed");

	// Test 3: POST /parcels without token -> should be 401 (Unauthorized: Missing token)
	console.log("Test 3: POST /parcels without token");
	const res3 = await fetch(`${BASE_URL}/parcels`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ trackingNumber: "TEST_NO_TOKEN", status: "ordered" }),
	});
	assert.strictEqual(res3.status, 401, "Should return 401 without token for POST");
	const body3 = await res3.json();
	assert.deepStrictEqual(body3, { error: "Unauthorized: Missing token" });
	console.log("✅ Passed");

	// Test 4: POST /parcels with invalid token -> should be 403 (Forbidden: Invalid token)
	console.log("Test 4: POST /parcels with invalid token");
	const res4 = await fetch(`${BASE_URL}/parcels?token=wrong_token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ trackingNumber: "TEST_WRONG_TOKEN", status: "ordered" }),
	});
	assert.strictEqual(res4.status, 403, "Should return 403 with invalid token for POST");
	const body4 = await res4.json();
	assert.deepStrictEqual(body4, { error: "Forbidden: Invalid token" });
	console.log("✅ Passed");

	// Test 5: POST /orders -> create order first (to link to parcel later)
	console.log("Test 5: POST /orders");
	const res5 = await fetch(`${BASE_URL}/orders?token=${ADMIN_TOKEN}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			source: "eBay",
			orderNumber: "EB-99887766",
			status: "processing",
		}),
	});
	assert.strictEqual(res5.status, 201, "Should create order");
	const newOrder = await res5.json();
	assert.strictEqual(newOrder.source, "eBay");
	assert.strictEqual(newOrder.orderNumber, "EB-99887766");
	console.log(`✅ Passed (Created order ID: ${newOrder.id})`);

	// Test 6: POST /parcels with admin token and link to orderId
	console.log("Test 6: POST /parcels with admin token and orderId link");
	const res6 = await fetch(`${BASE_URL}/parcels?token=${ADMIN_TOKEN}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			trackingNumber: "TEST12345",
			courier: "FedEx",
			status: "sent",
			lat: 34.0522,
			lng: -118.2437,
			orderId: newOrder.id,
		}),
	});
	assert.strictEqual(res6.status, 201, "Should successfully create parcel");
	const newParcel = await res6.json();
	assert.strictEqual(newParcel.trackingNumber, "TEST12345");
	assert.strictEqual(newParcel.courier, "FedEx");
	assert.strictEqual(newParcel.status, "sent");
	assert.strictEqual(newParcel.lat, 34.0522);
	assert.strictEqual(newParcel.orderId, newOrder.id, "Parcel should be linked to the order");
	console.log(`✅ Passed (Created parcel ID: ${newParcel.id})`);

	// Test 7: PATCH /parcels/:id -> should update details
	console.log(`Test 7: PATCH /parcels/${newParcel.id} to update status`);
	const res7 = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}?token=${ADMIN_TOKEN}`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "delivered", courier: "FedEx Express" }),
		},
	);
	assert.strictEqual(res7.status, 200, "Should update parcel");
	const updatedParcel = await res7.json();
	assert.strictEqual(updatedParcel.status, "delivered");
	assert.strictEqual(updatedParcel.courier, "FedEx Express");
	console.log("✅ Passed");

	// Test 8: POST /parcels/:id/events -> add event
	console.log(`Test 8: POST /parcels/${newParcel.id}/events`);
	const res8 = await fetch(
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
	assert.strictEqual(res8.status, 201, "Should create event");
	const event = await res8.json();
	assert.strictEqual(event.description, "Delivered at front door");
	assert.strictEqual(event.location, "Los Angeles Hub");
	console.log(`✅ Passed (Created event ID: ${event.id})`);

	// Test 9: GET /parcels/:id/events -> list events (no token needed)
	console.log(`Test 9: GET /parcels/${newParcel.id}/events`);
	const res9 = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}/events`,
	);
	assert.strictEqual(res9.status, 200, "Should return 200 without token");
	const events = await res9.json();
	assert.strictEqual(events.length, 1, "Should return exactly 1 event");
	assert.strictEqual(events[0].id, event.id);
	console.log("✅ Passed");

	// Test 10: GET /orders -> verify listing (no token needed)
	console.log("Test 10: GET /orders");
	const res10 = await fetch(`${BASE_URL}/orders`);
	assert.strictEqual(res10.status, 200, "Should return 200 without token");
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

	// Verify it is gone (no token needed)
	const res12Verify = await fetch(`${BASE_URL}/parcels`);
	const finalParcels = await res12Verify.json();
	const stillExists = finalParcels.some(
		(p: { id: number }) => p.id === newParcel.id,
	);
	assert.ok(!stillExists, "Parcel should not be in the list anymore");

	// Verify associated events are also deleted (no token needed)
	const res12VerifyEvents = await fetch(
		`${BASE_URL}/parcels/${newParcel.id}/events`,
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

