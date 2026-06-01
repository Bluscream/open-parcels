import type { SocketStream } from "@fastify/websocket";

export interface WsMessage {
	action: "subscribe" | "unsubscribe";
	topic: string;
}

export class WebSocketBroker {
	// Map of socket stream to its set of subscribed topics
	private connections = new Map<SocketStream, Set<string>>();

	/**
	 * Registers a new WebSocket connection and handles incoming messages
	 */
	public register(connection: SocketStream) {
		const subscribedTopics = new Set<string>();
		this.connections.set(connection, subscribedTopics);

		connection.socket.on("message", (rawData: unknown) => {
			try {
				const message: WsMessage = JSON.parse(String(rawData));
				if (!message.action || !message.topic) return;

				if (message.action === "subscribe") {
					subscribedTopics.add(message.topic);
					console.log(`[WS] Socket subscribed to topic: ${message.topic}`);
					// Send acknowledgment
					connection.socket.send(
						JSON.stringify({
							event: "subscribed",
							topic: message.topic,
							success: true,
						}),
					);
				} else if (message.action === "unsubscribe") {
					subscribedTopics.delete(message.topic);
					console.log(`[WS] Socket unsubscribed from topic: ${message.topic}`);
					connection.socket.send(
						JSON.stringify({
							event: "unsubscribed",
							topic: message.topic,
							success: true,
						}),
					);
				}
			} catch (err) {
				console.error("[WS] Failed to parse message:", err);
			}
		});

		connection.socket.on("close", () => {
			this.connections.delete(connection);
			console.log("[WS] Connection closed, unregistered socket.");
		});

		connection.socket.on("error", (err: Error) => {
			console.error("[WS] Socket error:", err);
			this.connections.delete(connection);
		});
	}

	/**
	 * Broadcasts an event to all sockets subscribed to the topic (or the global "all" topic)
	 */
	public broadcast(topic: string, data: unknown) {
		const payload = JSON.stringify({
			event: "parcel_update",
			topic,
			data,
		});

		let count = 0;
		for (const [connection, topics] of this.connections.entries()) {
			if (topics.has(topic) || topics.has("all")) {
				try {
					if (connection.socket.readyState === 1) {
						// 1 = OPEN
						connection.socket.send(payload);
						count++;
					}
				} catch (err) {
					console.error("[WS] Failed to send broadcast to socket:", err);
				}
			}
		}
		console.log(
			`[WS] Broadcasted event on topic "${topic}" to ${count} subscribers.`,
		);
	}
}

export const wsBroker = new WebSocketBroker();
