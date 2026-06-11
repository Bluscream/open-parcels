import assert from "node:assert";
import type { SocketStream } from "@fastify/websocket";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { parcels } from "../src/db/schema";
import { wsBroker } from "../src/services/websocket";

// A mock WebSocket connection to simulate the Fastify SocketStream
class MockSocket {
	public sentMessages: string[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: mock socket event handlers map
	private eventHandlers: { [key: string]: ((data: any) => void)[] } = {};
	public readyState = 1; // OPEN

	// biome-ignore lint/suspicious/noExplicitAny: mock socket event listener registration
	public on(event: string, handler: (data: any) => void) {
		if (!this.eventHandlers[event]) {
			this.eventHandlers[event] = [];
		}
		this.eventHandlers[event].push(handler);
	}

	public send(data: string) {
		this.sentMessages.push(data);
	}

	// Trigger an event from the client side
	// biome-ignore lint/suspicious/noExplicitAny: mock socket event trigger payload
	public trigger(event: string, data: any) {
		const handlers = this.eventHandlers[event] || [];
		for (const h of handlers) {
			h(data);
		}
	}
}

async function runTests() {
	console.log("🧪 Starting Amazon Live Real-Time & WebSockets Unit Tests...\n");

	// --- 1. Database Nickname Schema Test ---
	console.log("Step 1: Testing parcel nickname database schema...");
	const testTrackingNr = `DE_TEST_${Date.now()}`;

	// Insert parcel with custom nickname name
	const [newParcel] = await db
		.insert(parcels)
		.values({
			trackingNumber: testTrackingNr,
			name: "Mock Nike Shoes",
			status: "ordered",
			addedAt: new Date(),
			updatedAt: new Date(),
		})
		.returning();

	assert.strictEqual(
		newParcel.name,
		"Mock Nike Shoes",
		"Nickname name should be saved correctly on insert",
	);

	// Update nickname
	const [updatedParcel] = await db
		.update(parcels)
		.set({ name: "Updated Nike Shoes", updatedAt: new Date() })
		.where(eq(parcels.id, newParcel.id))
		.returning();

	assert.strictEqual(
		updatedParcel.name,
		"Updated Nike Shoes",
		"Nickname should be updated correctly via DB update",
	);
	console.log("✅ DB Custom Nickname verification succeeded.");

	// --- 2. WebSocket Subscription & Broadcast Test ---
	console.log(
		"Step 2: Testing WebSocket broker subscriptions and broadcasts...",
	);

	const mockSocket = new MockSocket();
	const mockStream = {
		socket: mockSocket,
	} as unknown as SocketStream;

	// Register socket in the wsBroker
	wsBroker.register(mockStream);

	// Subscribe to the parcel topic
	const subscribeMsg = JSON.stringify({
		action: "subscribe",
		topic: `parcel:${testTrackingNr}`,
	});

	mockSocket.trigger("message", Buffer.from(subscribeMsg));

	// Verify subscription acknowledgment was received
	assert.strictEqual(
		mockSocket.sentMessages.length,
		1,
		"Should send subscription acknowledgment",
	);
	const ack = JSON.parse(mockSocket.sentMessages[0]);
	assert.strictEqual(ack.event, "subscribed", "Ack event should be subscribed");
	assert.strictEqual(
		ack.topic,
		`parcel:${testTrackingNr}`,
		"Ack topic should match",
	);

	// Broadcast update on that topic
	const broadcastPayload = {
		id: newParcel.id,
		trackingNumber: testTrackingNr,
		name: updatedParcel.name,
		status: "arriving",
		stopsRemaining: 2,
		calloutMessage: "Arriving today",
		secondaryStatus: "2 stops away",
		lat: 52.52,
		lng: 13.4049,
	};

	wsBroker.broadcast(`parcel:${testTrackingNr}`, broadcastPayload);

	// Verify the socket received the update broadcast
	assert.strictEqual(
		mockSocket.sentMessages.length,
		2,
		"Should receive broadcast message",
	);
	const broadcastMsg = JSON.parse(mockSocket.sentMessages[1]);
	assert.strictEqual(
		broadcastMsg.event,
		"parcel_update",
		"Event type should be parcel_update",
	);
	assert.strictEqual(
		broadcastMsg.topic,
		`parcel:${testTrackingNr}`,
		"Topic should match",
	);
	assert.strictEqual(
		broadcastMsg.data.stopsRemaining,
		2,
		"Payload stops remaining should match",
	);
	assert.strictEqual(
		broadcastMsg.data.name,
		"Updated Nike Shoes",
		"Payload nickname name should match",
	);

	console.log(
		"✅ WebSocket Broker subscription & broadcast verification succeeded.",
	);

	// --- 3. Clean up database ---
	console.log("Step 3: Cleaning up test data...");
	await db.delete(parcels).where(eq(parcels.id, newParcel.id));
	const check = await db
		.select()
		.from(parcels)
		.where(eq(parcels.id, newParcel.id))
		.limit(1);
	assert.strictEqual(check.length, 0, "Test parcel should be deleted");
	console.log("✅ Clean up succeeded.");

	console.log("\n🎉 All tests passed successfully!");
}

runTests().catch((err) => {
	console.error("\n❌ Tests failed:", err);
	process.exit(1);
});
