/* biome-ignore-all lint/suspicious/noExplicitAny: fastify handlers use any for request/reply */
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import {
	credentials,
	orders,
	parcelEvents,
	parcels,
	settings,
} from "../db/schema";
import { trackAndUpdateParcel } from "../services/tracking/aggregator";
import { wsBroker } from "../services/websocket";
import { decryptCredential, encryptCredential } from "../utils/crypto";
import { geocodeLocation } from "../utils/geocoder";

// Basic Auth hook to check token
const checkAuth = async (request: any, reply: any) => {
	const token =
		request.headers.authorization?.replace("Bearer ", "") ||
		request.query.token ||
		request.body?.token;

	const guestToken = process.env.OPENPARCELS_TOKEN_GUEST;
	const adminToken = process.env.OPENPARCELS_TOKEN_ADMIN;

	const hasGuestTokenConfigured = !!(guestToken && guestToken.trim() !== "");

	// If no token is provided:
	if (!token) {
		if (hasGuestTokenConfigured) {
			return reply.code(401).send({ error: "Unauthorized: Missing token" });
		}
		// No guest token configured, allow GET requests as guest
		request.user = { isGuest: true, isAdmin: false };
		if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
			return reply
				.code(401)
				.send({ error: "Unauthorized: Admin token required" });
		}
		return;
	}

	// If token is provided:
	const isAdmin = token === adminToken;
	const isGuest = hasGuestTokenConfigured ? token === guestToken : true;

	if (!isAdmin && hasGuestTokenConfigured && token !== guestToken) {
		return reply.code(403).send({ error: "Forbidden: Invalid token" });
	}

	request.user = { isGuest, isAdmin };

	// Block write actions for guests
	if (!isAdmin && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
		return reply
			.code(403)
			.send({ error: "Forbidden: Admin token required for writes" });
	}
};

const stripNulls = (obj: any): any => {
	if (Array.isArray(obj)) {
		return obj.map(stripNulls);
	}
	if (obj && typeof obj === "object" && !(obj instanceof Date)) {
		return Object.fromEntries(
			Object.entries(obj)
				.filter(([_, v]) => v !== null)
				.map(([k, v]) => [k, stripNulls(v)]),
		);
	}
	return obj;
};

export async function apiRoutes(fastify: FastifyInstance) {
	fastify.addHook("preHandler", checkAuth);

	// WebSocket live connection route
	fastify.get("/ws", { websocket: true }, (connection, _req) => {
		wsBroker.register(connection);
	});

	// Helper to extract parameters from either body or query params
	const getParams = (request: any) => {
		return { ...request.query, ...request.body };
	};

	// --- PARCELS ---

	// GET /parcels - List all parcels
	fastify.get(
		"/parcels",
		{
			schema: {
				tags: ["Parcels"],
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "number" },
								trackingNumber: { type: "string" },
								courier: { type: "string", nullable: true },
								status: { type: "string" },
								lat: { type: "number", nullable: true },
								lng: { type: "number", nullable: true },
								estimatedDeliveryStart: { type: "string", nullable: true },
								estimatedDeliveryEnd: { type: "string", nullable: true },
								createdAt: { type: "string" },
								updatedAt: { type: "string" },
							},
						},
					},
				},
			},
		},
		async (_request, _reply) => {
			const allParcels = await db.select().from(parcels);
			return stripNulls(allParcels);
		},
	);

	const getSingleParcelHandler = async (request: any, reply: any) => {
		const { identifier } = request.params;
		let found: any[] = [];
		if (/^\d+$/.test(identifier)) {
			found = await db
				.select()
				.from(parcels)
				.where(eq(parcels.id, parseInt(identifier, 10)))
				.limit(1);
		}
		if (found.length === 0) {
			found = await db
				.select()
				.from(parcels)
				.where(eq(parcels.trackingNumber, identifier))
				.limit(1);
		}
		if (found.length === 0) {
			return reply.code(404).send({ error: "Parcel not found" });
		}
		return stripNulls(found[0]);
	};

	// GET /parcels/:identifier & GET /parcel/:identifier - Get a single parcel by ID or tracking number
	fastify.get(
		"/parcels/:identifier",
		{
			schema: {
				tags: ["Parcels"],
				params: {
					type: "object",
					properties: {
						identifier: { type: "string" },
					},
				},
			},
		},
		getSingleParcelHandler,
	);

	fastify.get(
		"/parcel/:identifier",
		{
			schema: {
				tags: ["Parcels"],
				params: {
					type: "object",
					properties: {
						identifier: { type: "string" },
					},
				},
			},
		},
		getSingleParcelHandler,
	);

	// POST /parcels - Create a parcel
	fastify.post(
		"/parcels",
		{
			schema: {
				tags: ["Parcels"],
				body: {
					type: "object",
					required: ["trackingNumber", "status"],
					properties: {
						trackingNumber: { type: "string" },
						name: { type: "string" },
						courier: { type: "string" },
						status: { type: "string" },
						lat: { type: "number" },
						lng: { type: "number" },
					},
				},
			},
		},
		async (request: any, reply) => {
			const params = getParams(request);
			const { trackingNumber, name, courier, status, lat, lng } = params;

			if (!trackingNumber || !status) {
				return reply
					.code(400)
					.send({ error: "Missing required fields: trackingNumber, status" });
			}

			const newParcel = await db
				.insert(parcels)
				.values({
					trackingNumber,
					name: name || null,
					courier: courier || null,
					status,
					lat: lat ? parseFloat(lat) : null,
					lng: lng ? parseFloat(lng) : null,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.returning();

			const insertedParcel = newParcel[0];

			// Automatically trigger a live tracking query immediately upon creation
			try {
				await trackAndUpdateParcel(insertedParcel.id);
			} catch (err) {
				fastify.log.error(err as any, `Auto-tracking failed for parcel ${insertedParcel.id}`);
			}

			// Fetch the updated parcel record from the DB
			const latestParcel = await db
				.select()
				.from(parcels)
				.where(eq(parcels.id, insertedParcel.id))
				.limit(1);

			return reply.code(201).send(latestParcel[0] || insertedParcel);
		},
	);

	// Update a parcel helper
	const updateParcelHandler = async (request: any, reply: any) => {
		const { id } = request.params;
		const params = getParams(request);
		const {
			name,
			courier,
			status,
			lat,
			lng,
			estimatedDeliveryStart,
			estimatedDeliveryEnd,
		} = params;

		const updateData: {
			updatedAt: Date;
			name?: string;
			courier?: string;
			status?: string;
			lat?: number | null;
			lng?: number | null;
			estimatedDeliveryStart?: Date | null;
			estimatedDeliveryEnd?: Date | null;
		} = {
			updatedAt: new Date(),
		};

		if (name !== undefined) updateData.name = name;
		if (courier !== undefined) updateData.courier = courier;
		if (status !== undefined) updateData.status = status;
		if (lat !== undefined) updateData.lat = lat ? parseFloat(lat) : null;
		if (lng !== undefined) updateData.lng = lng ? parseFloat(lng) : null;
		if (estimatedDeliveryStart !== undefined)
			updateData.estimatedDeliveryStart = estimatedDeliveryStart
				? new Date(estimatedDeliveryStart)
				: null;
		if (estimatedDeliveryEnd !== undefined)
			updateData.estimatedDeliveryEnd = estimatedDeliveryEnd
				? new Date(estimatedDeliveryEnd)
				: null;

		const updated = await db
			.update(parcels)
			.set(updateData)
			.where(eq(parcels.id, parseInt(id, 10)))
			.returning();

		if (updated.length === 0) {
			return reply.code(404).send({ error: "Parcel not found" });
		}

		return updated[0];
	};

	// PATCH /parcels/:id - Update parcel
	fastify.patch(
		"/parcels/:id",
		{
			schema: { tags: ["Parcels"] },
		},
		updateParcelHandler,
	);

	// POST /parcels/:id/update - Update parcel (alternative)
	fastify.post(
		"/parcels/:id/update",
		{
			schema: { tags: ["Parcels"] },
		},
		updateParcelHandler,
	);

	// Live tracking trigger handler
	const trackParcelHandler = async (request: any, reply: any) => {
		const { id } = request.params;
		const success = await trackAndUpdateParcel(parseInt(id, 10));
		if (!success) {
			return reply
				.code(400)
				.send({ error: "Could not resolve tracking or parcel not found" });
		}
		const updated = await db
			.select()
			.from(parcels)
			.where(eq(parcels.id, parseInt(id, 10)))
			.limit(1);
		return updated[0];
	};

	// GET /parcels/:id/track - Trigger live tracking update
	fastify.get(
		"/parcels/:id/track",
		{
			schema: { tags: ["Parcels"] },
		},
		trackParcelHandler,
	);

	// POST /parcels/:id/track - Trigger live tracking update
	fastify.post(
		"/parcels/:id/track",
		{
			schema: { tags: ["Parcels"] },
		},
		trackParcelHandler,
	);

	// Delete parcel helper
	const deleteParcelHandler = async (request: any, reply: any) => {
		const { id } = request.params;

		// Delete associated events first
		await db
			.delete(parcelEvents)
			.where(eq(parcelEvents.parcelId, parseInt(id, 10)));

		const deleted = await db
			.delete(parcels)
			.where(eq(parcels.id, parseInt(id, 10)))
			.returning();

		if (deleted.length === 0) {
			return reply.code(404).send({ error: "Parcel not found" });
		}

		return { message: "Parcel deleted successfully", parcel: deleted[0] };
	};

	// DELETE /parcels/:id - Delete parcel
	fastify.delete(
		"/parcels/:id",
		{
			schema: { tags: ["Parcels"] },
		},
		deleteParcelHandler,
	);

	// POST /parcels/:id/delete - Delete parcel (alternative)
	fastify.post(
		"/parcels/:id/delete",
		{
			schema: { tags: ["Parcels"] },
		},
		deleteParcelHandler,
	);

	// --- ORDERS ---

	// GET /orders - List all orders
	fastify.get(
		"/orders",
		{
			schema: {
				tags: ["Orders"],
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "number" },
								source: { type: "string" },
								orderNumber: { type: "string" },
								status: { type: "string" },
								createdAt: { type: "string" },
								updatedAt: { type: "string" },
							},
						},
					},
				},
			},
		},
		async (_request, _reply) => {
			const allOrders = await db.select().from(orders);
			return allOrders;
		},
	);

	// POST /orders - Create order
	fastify.post(
		"/orders",
		{
			schema: {
				tags: ["Orders"],
				body: {
					type: "object",
					required: ["source", "orderNumber", "status"],
					properties: {
						source: { type: "string" },
						orderNumber: { type: "string" },
						status: { type: "string" },
					},
				},
			},
		},
		async (request: any, reply) => {
			const params = getParams(request);
			const { source, orderNumber, status } = params;

			if (!source || !orderNumber || !status) {
				return reply.code(400).send({
					error: "Missing required fields: source, orderNumber, status",
				});
			}

			const newOrder = await db
				.insert(orders)
				.values({
					source,
					orderNumber,
					status,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.returning();

			return reply.code(201).send(newOrder[0]);
		},
	);

	// Delete order handler
	const deleteOrderHandler = async (request: any, reply: any) => {
		const { id } = request.params;
		const deleted = await db
			.delete(orders)
			.where(eq(orders.id, parseInt(id, 10)))
			.returning();

		if (deleted.length === 0) {
			return reply.code(404).send({ error: "Order not found" });
		}

		return { message: "Order deleted successfully", order: deleted[0] };
	};

	// DELETE /orders/:id
	fastify.delete(
		"/orders/:id",
		{
			schema: { tags: ["Orders"] },
		},
		deleteOrderHandler,
	);

	// POST /orders/:id/delete
	fastify.post(
		"/orders/:id/delete",
		{
			schema: { tags: ["Orders"] },
		},
		deleteOrderHandler,
	);

	// --- PARCEL EVENTS ---

	const getParcelEventsHandler = async (request: any, _reply: any) => {
		const { id } = request.params;
		let numericId: number | null = null;
		if (/^\d+$/.test(id)) {
			numericId = parseInt(id, 10);
		} else {
			const found = await db
				.select()
				.from(parcels)
				.where(eq(parcels.trackingNumber, id))
				.limit(1);
			if (found.length > 0) {
				numericId = found[0].id;
			}
		}
		if (numericId === null) {
			return [];
		}
		const events = await db
			.select()
			.from(parcelEvents)
			.where(eq(parcelEvents.parcelId, numericId));
		return stripNulls(events);
	};

	// GET /parcels/:id/events & GET /parcel/:id/events - List events for a parcel (id can be numeric ID or tracking number)
	fastify.get(
		"/parcels/:id/events",
		{
			schema: {
				tags: ["Events"],
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "number" },
								parcelId: { type: "number" },
								location: { type: "string", nullable: true },
								description: { type: "string" },
								timestamp: { type: "string" },
								lat: { type: "number", nullable: true },
								lng: { type: "number", nullable: true },
							},
						},
					},
				},
			},
		},
		getParcelEventsHandler,
	);

	fastify.get(
		"/parcel/:id/events",
		{
			schema: {
				tags: ["Events"],
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "number" },
								parcelId: { type: "number" },
								location: { type: "string", nullable: true },
								description: { type: "string" },
								timestamp: { type: "string" },
								lat: { type: "number", nullable: true },
								lng: { type: "number", nullable: true },
							},
						},
					},
				},
			},
		},
		getParcelEventsHandler,
	);

	// POST /parcels/:id/events - Create an event for a parcel
	fastify.post(
		"/parcels/:id/events",
		{
			schema: {
				tags: ["Events"],
				body: {
					type: "object",
					required: ["description"],
					properties: {
						location: { type: "string" },
						description: { type: "string" },
						timestamp: { type: "string" },
					},
				},
			},
		},
		async (request: any, reply) => {
			const { id } = request.params;
			const params = getParams(request);
			const { location, description, timestamp } = params;

			if (!description) {
				return reply
					.code(400)
					.send({ error: "Missing required field: description" });
			}

			const newEvent = await db
				.insert(parcelEvents)
				.values({
					parcelId: parseInt(id, 10),
					location: location || null,
					description,
					timestamp: timestamp ? new Date(timestamp) : new Date(),
				})
				.returning();

			return reply.code(201).send(newEvent[0]);
		},
	);

	// Delete event handler
	const deleteEventHandler = async (request: any, reply: any) => {
		const { id } = request.params;
		const deleted = await db
			.delete(parcelEvents)
			.where(eq(parcelEvents.id, parseInt(id, 10)))
			.returning();

		if (deleted.length === 0) {
			return reply.code(404).send({ error: "Event not found" });
		}

		return { message: "Event deleted successfully", event: deleted[0] };
	};

	// DELETE /events/:id
	fastify.delete(
		"/events/:id",
		{
			schema: { tags: ["Events"] },
		},
		deleteEventHandler,
	);

	// POST /events/:id/delete
	fastify.post(
		"/events/:id/delete",
		{
			schema: { tags: ["Events"] },
		},
		deleteEventHandler,
	);

	// --- CREDENTIALS ---

	// GET /credentials - List all credential services (no secrets)
	fastify.get(
		"/credentials",
		{
			schema: {
				tags: ["Credentials"],
				response: {
					200: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "number" },
								service: { type: "string" },
								updatedAt: { type: "string" },
							},
						},
					},
				},
			},
		},
		async (request: any, reply) => {
			// Only admins can see credentials
			if (!request.user.isAdmin) {
				return reply
					.code(403)
					.send({ error: "Forbidden: Admin token required" });
			}
			const allCreds = await db.select().from(credentials);
			return allCreds.map((c) => ({
				id: c.id,
				service: c.service,
				updatedAt: c.updatedAt.toISOString(),
			}));
		},
	);

	// GET /credentials/:service - Get decrypted credential for a service
	fastify.get(
		"/credentials/:service",
		{
			schema: { tags: ["Credentials"] },
		},
		async (request: any, reply) => {
			if (!request.user.isAdmin) {
				return reply
					.code(403)
					.send({ error: "Forbidden: Admin token required" });
			}
			const { service } = request.params;
			const found = await db
				.select()
				.from(credentials)
				.where(eq(credentials.service, service))
				.limit(1);
			if (found.length === 0) {
				return reply
					.code(404)
					.send({ error: "Credentials not found for this service" });
			}
			try {
				const decryptedStr = decryptCredential(found[0].encryptedData);
				const data = JSON.parse(decryptedStr);
				return {
					id: found[0].id,
					service: found[0].service,
					data,
					updatedAt: found[0].updatedAt,
				};
			} catch (_err) {
				return reply.code(500).send({ error: "Failed to decrypt credentials" });
			}
		},
	);

	// POST /credentials - Create or update credential
	fastify.post(
		"/credentials",
		{
			schema: {
				tags: ["Credentials"],
				body: {
					type: "object",
					required: ["service", "data"],
					properties: {
						service: { type: "string" },
						data: { type: "object" },
					},
				},
			},
		},
		async (request: any, reply) => {
			const params = getParams(request);
			const { service, data } = params;

			if (!service || !data) {
				return reply
					.code(400)
					.send({ error: "Missing required fields: service, data" });
			}

			const encryptedData = encryptCredential(JSON.stringify(data));

			// Check if service already exists
			const existing = await db
				.select()
				.from(credentials)
				.where(eq(credentials.service, service))
				.limit(1);

			if (existing.length > 0) {
				const updated = await db
					.update(credentials)
					.set({
						encryptedData,
						updatedAt: new Date(),
					})
					.where(eq(credentials.service, service))
					.returning();
				return reply.code(200).send({
					message: "Credentials updated successfully",
					service: updated[0].service,
				});
			} else {
				const inserted = await db
					.insert(credentials)
					.values({
						service,
						encryptedData,
						updatedAt: new Date(),
					})
					.returning();
				return reply.code(201).send({
					message: "Credentials created successfully",
					service: inserted[0].service,
				});
			}
		},
	);

	// DELETE /credentials/:id
	fastify.delete(
		"/credentials/:id",
		{
			schema: { tags: ["Credentials"] },
		},
		async (request: any, reply) => {
			const { id } = request.params;
			const deleted = await db
				.delete(credentials)
				.where(eq(credentials.id, parseInt(id, 10)))
				.returning();

			if (deleted.length === 0) {
				return reply.code(404).send({ error: "Credentials not found" });
			}

			return {
				message: "Credentials deleted successfully",
				service: deleted[0].service,
			};
		},
	);

	// POST /credentials/:id/delete (alternative)
	fastify.post(
		"/credentials/:id/delete",
		{
			schema: { tags: ["Credentials"] },
		},
		async (request: any, reply) => {
			const { id } = request.params;
			const deleted = await db
				.delete(credentials)
				.where(eq(credentials.id, parseInt(id, 10)))
				.returning();

			if (deleted.length === 0) {
				return reply.code(404).send({ error: "Credentials not found" });
			}

			return {
				message: "Credentials deleted successfully",
				service: deleted[0].service,
			};
		},
	);

	// --- SETTINGS ---

	// GET /settings - Retrieve all settings (admins and guests can read)
	fastify.get(
		"/settings",
		{
			schema: { tags: ["Settings"] },
		},
		async (_request: any, reply) => {
			try {
				const dbSettings = await db.select().from(settings);
				const settingsMap = Object.fromEntries(
					dbSettings.map((s) => [s.key, s.value]),
				);

				// Merge with env var fallbacks or default fallbacks
				const home_latitude =
					settingsMap.home_latitude ||
					process.env.HOME_LATITUDE ||
					process.env.LATITUDE ||
					process.env.LAT ||
					"50.1109";

				const home_longitude =
					settingsMap.home_longitude ||
					process.env.HOME_LONGITUDE ||
					process.env.LONGITUDE ||
					process.env.LNG ||
					"8.6821";

				const home_name =
					settingsMap.home_name ||
					process.env.HOME_NAME ||
					"Home (Destination)";

				const timezone =
					settingsMap.timezone ||
					process.env.TIMEZONE ||
					process.env.TZ ||
					"Europe/Berlin";

				return {
					home_latitude: parseFloat(home_latitude),
					home_longitude: parseFloat(home_longitude),
					home_name,
					timezone,
				};
			} catch (_err) {
				return reply.code(500).send({ error: "Failed to fetch settings" });
			}
		},
	);

	// POST /settings - Update setting values (admins only)
	fastify.post(
		"/settings",
		{
			schema: {
				tags: ["Settings"],
				body: {
					type: "object",
					properties: {
						home_latitude: { type: "number" },
						home_longitude: { type: "number" },
						home_name: { type: "string" },
						timezone: { type: "string" },
					},
				},
			},
		},
		async (request: any, reply) => {
			try {
				const params = getParams(request);
				const allowedKeys = [
					"home_latitude",
					"home_longitude",
					"home_name",
					"timezone",
				];

				for (const key of allowedKeys) {
					if (params[key] !== undefined) {
						const value = String(params[key]);

						// Upsert settings in database
						await db
							.insert(settings)
							.values({
								key,
								value,
								updatedAt: new Date(),
							})
							.onConflictDoUpdate({
								target: settings.key,
								set: { value, updatedAt: new Date() },
							});
					}
				}

				return { message: "Settings saved successfully" };
			} catch (err) {
				console.error("[Settings] Failed to save settings:", err);
				return reply.code(500).send({ error: "Failed to save settings" });
			}
		},
	);

	// GET /geocode - Geocode a location search query
	fastify.get(
		"/geocode",
		{
			schema: {
				tags: ["Utility"],
				query: {
					type: "object",
					required: ["q"],
					properties: {
						q: { type: "string" },
					},
				},
			},
		},
		async (request: any, reply) => {
			try {
				const { q } = request.query;
				if (!q) {
					return reply
						.code(400)
						.send({ error: 'Missing required query parameter "q"' });
				}
				const coords = await geocodeLocation(q);
				if (!coords) {
					return reply.code(404).send({ error: "Location not found" });
				}
				return coords;
			} catch (err) {
				console.error("[Geocode] Search failed:", err);
				return reply.code(500).send({ error: "Failed to geocode location" });
			}
		},
	);
}
