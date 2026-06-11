import type { SocketStream } from "@fastify/websocket";

export interface WsMessage {
	action: "subscribe" | "unsubscribe";
	topic: string;
}

export interface LogItem {
	timestamp: string;
	level: string;
	message: string;
}

const logHistory: LogItem[] = [];
const MAX_LOG_HISTORY = 200;

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
					// Send acknowledgment
					connection.socket.send(
						JSON.stringify({
							event: "subscribed",
							topic: message.topic,
							success: true,
						}),
					);

					// Send recent log history to the newly subscribed client
					if (message.topic === "logs") {
						for (const logItem of logHistory) {
							connection.socket.send(
								JSON.stringify({
									event: "log_message",
									topic: "logs",
									data: logItem,
								}),
							);
						}
					}
					console.log(`[WS] Socket subscribed to topic: ${message.topic}`);
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
	public broadcast(topic: string, data: unknown, event = "parcel_update") {
		const payload = JSON.stringify({
			event,
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
	}
}

export const wsBroker = new WebSocketBroker();

// Live system logs broadcasting via WebSocket
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

const broadcastLog = (level: string, ...args: any[]) => {
	const message = args.map(arg => {
		if (arg instanceof Error) return arg.stack || arg.message;
		return typeof arg === "object" ? JSON.stringify(arg) : String(arg);
	}).join(" ");
	
	const logPayload = {
		timestamp: new Date().toISOString(),
		level,
		message,
	};

	logHistory.push(logPayload);
	if (logHistory.length > MAX_LOG_HISTORY) {
		logHistory.shift();
	}

	wsBroker.broadcast("logs", logPayload, "log_message");
};

console.log = (...args: any[]) => {
	originalLog(...args);
	broadcastLog("info", ...args);
};
console.info = (...args: any[]) => {
	originalInfo(...args);
	broadcastLog("info", ...args);
};
console.warn = (...args: any[]) => {
	originalWarn(...args);
	broadcastLog("warn", ...args);
};
console.error = (...args: any[]) => {
	originalError(...args);
	broadcastLog("error", ...args);
};
