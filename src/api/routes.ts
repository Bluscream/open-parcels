/* biome-ignore-all lint/suspicious/noExplicitAny: fastify handlers use any for request/reply */
import fs from "node:fs";
import path from "node:path";
import { and, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { client } from "../db";
import {
	credentials,
	orders,
	parcelEvents,
	parcels,
	settings,
} from "../db/schema";
import { trackAndUpdateParcel, aggregator } from "../services/tracking/aggregator";
import { syncParcelStateFromEvents, determineSingleEventVehicle } from "../services/tracking/sync";
import { getActiveParcelRules } from "../services/ingest/rules-loader";
import { AmazonLiveScraper } from "../services/scrapers/amazon-live-scraper";
import { wsBroker } from "../services/websocket";
import { decryptCredential, encryptCredential } from "../utils/crypto";
import { geocodeLocation, extractLocationName, isLikelyLocation } from "../utils/geocoder";
import { simpleParser } from "mailparser";
import AdmZip from "adm-zip";
import { TrackingParser, EmailParser } from "../services/ingest/parser";
import { loadRemoteRules } from "../services/ingest/rules-loader";

// Basic Auth hook to check token
const checkAuth = async (request: any, reply: any) => {
	const configuredToken = process.env.OPENPARCELS_TOKEN;
	const isAuthRequired = !!(configuredToken && configuredToken.trim() !== "");

	const token =
		request.headers.authorization?.replace("Bearer ", "") ||
		request.query.token ||
		request.body?.token;

	const isAdmin = !isAuthRequired || (!!token && token === configuredToken);

	// Read-only operations (GET, HEAD) never require token
	if (request.method === "GET" || request.method === "HEAD") {
		request.user = { isGuest: true, isAdmin };
		return;
	}

	// If no auth is required (no token configured):
	if (!isAuthRequired) {
		request.user = { isGuest: false, isAdmin: true };
		return;
	}

	// Auth is required for write:
	if (!token) {
		return reply.code(401).send({ error: "Unauthorized: Missing token" });
	}

	if (token !== configuredToken) {
		return reply.code(403).send({ error: "Forbidden: Invalid token" });
	}

	request.user = { isGuest: false, isAdmin: true };
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
								addedAt: { type: "string" },
								updatedAt: { type: "string" },
								orderId: { type: "number", nullable: true },
								lastVehicle: { type: "string", nullable: true },
								lastEventDescription: { type: "string", nullable: true },
								events: {
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
											vehicle: { type: "string", nullable: true },
											source: { type: "string", nullable: true },
										},
									},
								},
							},
						},
					},
				},
			},
		},
		async (_request, _reply) => {
			const allParcels = await db.select().from(parcels);
			const result = [];
			for (const p of allParcels) {
				const evs = await db
					.select()
					.from(parcelEvents)
					.where(eq(parcelEvents.parcelId, p.id));
				result.push({
					...p,
					events: evs,
				});
			}
			return stripNulls(result);
		},
	);

	// GET /couriers - Returns loaded parcel rule metadata (id, name, icon_url) for the frontend
	fastify.get("/couriers", async (_request, _reply) => {
		const rules = getActiveParcelRules();
		return rules.map((r: any) => ({
			id: r.id,
			name: r.name,
			iconUrl: r.icon_url || null,
		}));
	});

	// Delegate to the shared vehicle classifier so there's one source of truth.
	const determineRouteTransportMethod = (events: any[]): string => {
		if (!events || events.length === 0) return "unknown";
		const sortedEventsDesc = [...events].sort((a: any, b: any) => {
			const timeA = a.timestamp ? new Date(a.timestamp).getTime() : (a.date ? new Date(a.date).getTime() : 0);
			const timeB = b.timestamp ? new Date(b.timestamp).getTime() : (b.date ? new Date(b.date).getTime() : 0);
			return timeB - timeA;
		});
		for (const event of sortedEventsDesc) {
			const v = determineSingleEventVehicle(event.description || "", event.status || event.location || "");
			if (v !== "unknown") return v;
		}
		return "unknown";
	};

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
			if (/^\d+$/.test(identifier)) {
				return reply.code(404).send({ error: "Parcel not found" });
			}
			const trackingInfo = await aggregator.aggregate(identifier);
			if (trackingInfo) {
				// Resolve temporary coordinates from the latest event if possible
				let lat: number | null = null;
				let lng: number | null = null;
				const sortedEventsDesc = [...trackingInfo.events].sort(
					(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
				);
				for (const ev of sortedEventsDesc) {
					let locationName = (ev.location && isLikelyLocation(ev.location)) ? ev.location : null;
					if (!locationName && ev.description) locationName = extractLocationName(ev.description);
					if (!locationName && ev.status) locationName = extractLocationName(ev.status);
					if (locationName) {
						const coords = await geocodeLocation(locationName);
						if (coords) {
							lat = coords.lat;
							lng = coords.lng;
							break;
						}
					}
				}
				return stripNulls({
					id: 0,
					trackingNumber: trackingInfo.trackingNumber,
					courier: trackingInfo.courier,
					status: trackingInfo.status,
					lat,
					lng,
					estimatedDeliveryStart: trackingInfo.estimatedDelivery || null,
					addedAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					temp: true,
					orderId: null,
					lastVehicle: determineRouteTransportMethod(trackingInfo.events),
				});
			}
			return reply.code(404).send({ error: "Parcel not found" });
		}
		const parcel = found[0];
		return stripNulls(parcel);
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

	// POST /parcels/preview - Resolve tracking details from a pasted URL or order link
	fastify.post(
		"/parcels/preview",
		{
			schema: {
				tags: ["Parcels"],
				body: {
					type: "object",
					required: ["url"],
					properties: {
						url: { type: "string" },
					},
				},
			},
		},
		async (request: any, reply) => {
			const { url } = request.body;
			if (!url) return reply.code(400).send({ error: "Missing url parameter" });

			let orderNo = "";
			let trackingNo = "";
			try {
				const parsedUrl = new URL(url);
				const params = new URLSearchParams(parsedUrl.search);
				orderNo = params.get("orderId") || params.get("orderID") || params.get("order_id") || "";
				trackingNo = params.get("shipmentId") || params.get("shipment_id") || params.get("tracking") || "";
			} catch (_) {}

			if (!orderNo && !trackingNo) {
				return reply.code(400).send({ error: "Could not parse Amazon order number or tracking information from this URL." });
			}

			try {
				const trackingInfo = await aggregator.aggregate(orderNo ? `${orderNo}::${trackingNo}` : trackingNo || "temp-preview-id");
				console.log(`[TrackingPreview] Amazon preview fetch completed. Events: ${trackingInfo?.events?.length || 0}`);
				return reply.send({
					trackingNumber: trackingInfo?.trackingNumber || trackingNo,
					itemName: (trackingInfo as any)?.itemName || "",
					provider: "Amazon",
					status: trackingInfo?.status || "sent",
					statusDescription: trackingInfo?.statusDescription || "In transit",
					events: trackingInfo?.events || []
				});
			} catch (err: any) {
				fastify.log.error(err);
				return reply.code(500).send({ error: `Preview scraping failed: ${err.message || err}` });
			}
		}
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
			const { trackingNumber, name, courier, status, lat, lng, orderId } = params;

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
					orderId: orderId ? parseInt(orderId, 10) : null,
					addedAt: new Date(),
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

			const finalParcel = latestParcel[0] || insertedParcel;
			const finalOrderId = orderId ? parseInt(orderId, 10) : null;

			return reply.code(201).send({ ...finalParcel, orderId: finalOrderId });
		},
	);

	// Update a parcel helper
	const updateParcelHandler = async (request: any, reply: any) => {
		const { id } = request.params;
		const params = getParams(request);
		const {
			trackingNumber,
			name,
			courier,
			status,
			lat,
			lng,
			estimatedDeliveryStart,
			estimatedDeliveryEnd,
			orderId,
		} = params;

		const updateData: {
			updatedAt: Date;
			trackingNumber?: string;
			name?: string;
			courier?: string;
			status?: string;
			lat?: number | null;
			lng?: number | null;
			estimatedDeliveryStart?: Date | null;
			estimatedDeliveryEnd?: Date | null;
			orderId?: number | null;
		} = {
			updatedAt: new Date(),
		};

		if (trackingNumber !== undefined) updateData.trackingNumber = trackingNumber;
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
		if (orderId !== undefined) {
			updateData.orderId = (orderId !== null && orderId !== "") ? parseInt(orderId, 10) : null;
		}

		const updated = await db
			.update(parcels)
			.set(updateData)
			.where(eq(parcels.id, parseInt(id, 10)))
			.returning();

		if (updated.length === 0) {
			return reply.code(404).send({ error: "Parcel not found" });
		}

		const resultParcel = updated[0];

		return resultParcel;
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


		// Delete associated events next
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
								placedAt: { type: "string", nullable: true },
								addedAt: { type: "string" },
								updatedAt: { type: "string" },
								parcelCount: { type: "number" },
							},
						},
					},
				},
			},
		},
		async (_request, _reply) => {
			const allOrders = await db.select().from(orders);
			const counts = await db
				.select({
					orderId: parcels.orderId,
					cnt: count(parcels.id),
				})
				.from(parcels)
				.groupBy(parcels.orderId);

			const countMap = new Map<number, number>();
			for (const row of counts) {
				if (row.orderId !== null) {
					countMap.set(row.orderId, row.cnt);
				}
			}

			const result = allOrders.map((o) => ({
				...o,
				parcelCount: countMap.get(o.id) || 0,
			}));

			return result;
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
						placedAt: { type: "string", nullable: true },
					},
				},
			},
		},
		async (request: any, reply) => {
			const params = getParams(request);
			const { source, orderNumber, status, placedAt } = params;

			if (!source || !orderNumber || !status) {
				return reply.code(400).send({
					error: "Missing required fields: source, orderNumber, status",
				});
			}

			// Check if order already exists to prevent duplicate entries
			const existing = await db
				.select()
				.from(orders)
				.where(
					and(
						eq(orders.orderNumber, orderNumber),
						eq(orders.source, source)
					)
				)
				.limit(1);

			if (existing.length > 0) {
				if (existing[0].status !== status) {
					const updated = await db
						.update(orders)
						.set({
							status,
							updatedAt: new Date(),
						})
						.where(eq(orders.id, existing[0].id))
						.returning();
					return reply.code(200).send(updated[0]);
				}
				return reply.code(200).send(existing[0]);
			}

			const newOrder = await db
				.insert(orders)
				.values({
					source,
					orderNumber,
					status,
					placedAt: placedAt ? new Date(placedAt) : null,
					addedAt: new Date(),
					updatedAt: new Date(),
				})
				.returning();

			const insertedOrder = newOrder[0];

			if (source.toLowerCase() === "amazon") {
				try {
					const trackingInfo = await aggregator.aggregate(orderNumber);
					if (trackingInfo && trackingInfo.raw) {
						const orderResp = (trackingInfo.raw as any).response;
						if (orderResp && Array.isArray(orderResp.shipments)) {
							for (const shipment of orderResp.shipments) {
								if (!shipment.tracking_id) continue;

								let existingParcel = await db
									.select()
									.from(parcels)
									.where(eq(parcels.trackingNumber, shipment.tracking_id))
									.limit(1);

								let parcelId: number;
								if (existingParcel.length === 0) {
									const newP = await db
										.insert(parcels)
										.values({
											trackingNumber: shipment.tracking_id,
											status: "ordered",
											courier: "Amazon",
											orderId: insertedOrder.id,
											addedAt: new Date(),
											updatedAt: new Date(),
										})
										.returning();
									parcelId = newP[0].id;
								} else {
									parcelId = existingParcel[0].id;
									await db.update(parcels).set({ orderId: insertedOrder.id }).where(eq(parcels.id, parcelId));
								}

								trackAndUpdateParcel(parcelId).catch((err) => {
									console.error(`[OrderAutoTrack] Failed to track parcel ${parcelId}:`, err);
								});
							}
						}
					}
				} catch (err) {
					console.error("[OrderAutoResolve] Error resolving order shipments:", err);
				}
			}

			return reply.code(201).send(insertedOrder);
		},
	);

	// GET /orders/:id - Get a single order by ID
	fastify.get(
		"/orders/:id",
		{ schema: { tags: ["Orders"] } },
		async (request: any, reply) => {
			const { id } = request.params;
			const found = await db
				.select()
				.from(orders)
				.where(eq(orders.id, parseInt(id, 10)))
				.limit(1);
			if (found.length === 0) return reply.code(404).send({ error: "Order not found" });
			return stripNulls(found[0]);
		},
	);

	// GET /orders/:id/parcels - List parcels linked to an order
	fastify.get(
		"/orders/:id/parcels",
		{ schema: { tags: ["Orders"] } },
		async (request: any, _reply) => {
			const { id } = request.params;
			const results = await db
				.select()
				.from(parcels)
				.where(eq(parcels.orderId, parseInt(id, 10)));
			return stripNulls(results);
		},
	);

	// POST /orders/:id/parcels - Link a parcel to an order by tracking number or parcel ID
	fastify.post(
		"/orders/:id/parcels",
		{ schema: { tags: ["Orders"] } },
		async (request: any, reply) => {
			const { id } = request.params;
			const params = getParams(request);
			const { trackingNumber, parcelId } = params;

			let foundParcel: any = null;
			if (parcelId) {
				const r = await db.select().from(parcels).where(eq(parcels.id, parseInt(parcelId, 10))).limit(1);
				if (r.length > 0) foundParcel = r[0];
			} else if (trackingNumber) {
				const r = await db.select().from(parcels).where(eq(parcels.trackingNumber, trackingNumber)).limit(1);
				if (r.length > 0) foundParcel = r[0];
			}

			if (!foundParcel) return reply.code(404).send({ error: "Parcel not found" });

			await db.update(parcels).set({ orderId: parseInt(id, 10) }).where(eq(parcels.id, foundParcel.id));

			return { message: "Parcel linked to order", parcelId: foundParcel.id };
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
		let foundParcel: any = null;

		if (/^\d+$/.test(id)) {
			const found = await db
				.select()
				.from(parcels)
				.where(eq(parcels.id, parseInt(id, 10)))
				.limit(1);
			if (found.length > 0) {
				foundParcel = found[0];
			}
		}
		if (!foundParcel) {
			const found = await db
				.select()
				.from(parcels)
				.where(eq(parcels.trackingNumber, id))
				.limit(1);
			if (found.length > 0) {
				foundParcel = found[0];
			}
		}

		if (!foundParcel) {
			if (/^\d+$/.test(id)) {
				return [];
			}
			const trackingInfo = await aggregator.aggregate(id);
			if (trackingInfo) {
				const events = [];
				for (let i = 0; i < trackingInfo.events.length; i++) {
					const ev = trackingInfo.events[i];
					let eventLat: number | null = null;
					let eventLng: number | null = null;
					let locationName = (ev.location && isLikelyLocation(ev.location)) ? ev.location : null;
					if (!locationName && ev.description) locationName = extractLocationName(ev.description);
					if (!locationName && ev.status) locationName = extractLocationName(ev.status);
					if (locationName) {
						const coords = await geocodeLocation(locationName);
						if (coords) {
							eventLat = coords.lat;
							eventLng = coords.lng;
						}
					}
					events.push({
						id: i + 1,
						parcelId: 0,
						location: locationName,
						description: ev.description || ev.status,
						timestamp: ev.date,
						lat: eventLat,
						lng: eventLng,
						source: ev.source || trackingInfo.courier || null,
					});
				}
				return stripNulls(events);
			}
			return [];
		}

		const events = await db
			.select()
			.from(parcelEvents)
			.where(eq(parcelEvents.parcelId, foundParcel.id));
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
								source: { type: "string", nullable: true },
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
								source: { type: "string", nullable: true },
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
						source: { type: "string" },
					},
				},
			},
		},
		async (request: any, reply) => {
			const { id } = request.params;
			const params = getParams(request);
			const { location, description, timestamp, source } = params;

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
					vehicle: determineSingleEventVehicle(description, location),
					source: source || "Manual",
				})
				.returning();
			const insertedEvent = newEvent[0];
			await syncParcelStateFromEvents(parseInt(id, 10));

			return reply.code(201).send(insertedEvent);
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

	// GET /status - Service overview stats
	fastify.get(
		"/status",
		{
			schema: { tags: ["Admin"] },
		},
		async (_request, _reply) => {
			const uptimeSeconds = Math.floor(process.uptime());

			const [parcelCount] = await db.select({ count: count() }).from(parcels);
			const [orderCount] = await db.select({ count: count() }).from(orders);
			const [credCount] = await db.select({ count: count() }).from(credentials);
			const [eventCount] = await db.select({ count: count() }).from(parcelEvents);

			// Count parcels by status
			const statusCounts = await db
				.select({ status: parcels.status, count: count() })
				.from(parcels)
				.groupBy(parcels.status);

			// Count orders by status
			const orderStatusCounts = await db
				.select({ status: orders.status, count: count() })
				.from(orders)
				.groupBy(orders.status);

			// DB file size
			const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data.db");
			let dbSizeBytes = 0;
			try {
				const stat = fs.statSync(dbPath);
				dbSizeBytes = stat.size;
			} catch { /* ignore */ }

			return {
				uptime: uptimeSeconds,
				parcels: parcelCount.count,
				orders: orderCount.count,
				credentials: credCount.count,
				events: eventCount.count,
				parcelsByStatus: statusCounts,
				ordersByStatus: orderStatusCounts,
				dbSizeBytes,
				nodeVersion: process.version,
				env: process.env.NODE_ENV || "production",
			};
		},
	);

	// GET /admin/db-backup - Download a SQL dump of the database
	fastify.get(
		"/admin/db-backup",
		{
			schema: { tags: ["Admin"] },
		},
		async (_request, reply) => {
			try {
				// Get all user-defined tables from sqlite_master
				const masterResult = await client.execute(
					"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rootpage"
				);

				const lines: string[] = [
					"-- OpenParcels SQL Dump",
					`-- Generated: ${new Date().toISOString()}`,
					"-- -----------------------------------------------",
					"PRAGMA foreign_keys = OFF;",
					"BEGIN TRANSACTION;",
					"",
				];

				for (const row of (masterResult as any).rows ?? []) {
					const tableName = row[0] as string;
					const createSql = row[1] as string;
					if (!createSql) continue;

					lines.push(`-- Table: ${tableName}`);
					lines.push(`DROP TABLE IF EXISTS ${JSON.stringify(tableName)};`);
					lines.push(`${createSql};`);

					// Fetch all rows for this table
					const rowsResult = await client.execute(`SELECT * FROM ${JSON.stringify(tableName)}`);
					const dataRows = rowsResult.rows ?? [];
					const colNames: string[] = rowsResult.columns ?? [];

					for (const dataRow of dataRows) {
						const vals = colNames.map((c) => {
							const v = (dataRow as Record<string, unknown>)[c];
							if (v === null) return "NULL";
							if (typeof v === "number") return String(v);
							return `'${String(v).replace(/'/g, "''")}'`;
						});
						const cols = colNames.map((c) => JSON.stringify(c)).join(", ");
						lines.push(`INSERT INTO ${JSON.stringify(tableName)} (${cols}) VALUES (${vals.join(", ")});`);
					}
					lines.push("");
				}

				lines.push("COMMIT;");
				lines.push("PRAGMA foreign_keys = ON;");

				const sqlDump = lines.join("\n");
				const filename = `openparcels-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.sql`;

				reply
					.header("Content-Type", "text/plain; charset=utf-8")
					.header("Content-Disposition", `attachment; filename="${filename}"`)
					.send(sqlDump);
			} catch (err) {
				console.error("[DB-Backup] Failed to generate SQL dump:", err);
				return reply.code(500).send({ error: "Failed to generate SQL dump" });
			}
		},
	);

	// POST /admin/db-restore - Upload a .sql dump and restore it into the database
	fastify.post(
		"/admin/db-restore",
		{
			schema: { tags: ["Admin"] },
		},
		async (request: any, reply) => {
			try {
				const data = await request.file();
				if (!data) {
					return reply.code(400).send({ error: "No file uploaded" });
				}
				const chunks: Buffer[] = [];
				for await (const chunk of data.file) {
					chunks.push(Buffer.from(chunk));
				}
				const sqlText = Buffer.concat(chunks).toString("utf-8");
				if (!sqlText.trim()) {
					return reply.code(400).send({ error: "Uploaded file is empty" });
				}

				// Safety: back up the current raw DB file before touching anything
				const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data.db");
				if (fs.existsSync(dbPath)) {
					const backupPath = dbPath.replace(".db", `-pre-restore-${Date.now()}.db`);
					fs.copyFileSync(dbPath, backupPath);
				}

				// Split SQL into individual statements, skip blank lines and comment-only lines
				const statements = sqlText
					.split(";")
					.map((s) => s.trim())
					.filter((s) => s.length > 0 && !s.replace(/--[^\n]*/g, "").trim().startsWith(""));

				const IGNORABLE = ["PRAGMA", "BEGIN", "COMMIT", "ROLLBACK"];
				for (const stmt of statements) {
					// Skip pure comment lines
					const stripped = stmt.replace(/--[^\n]*/g, "").trim();
					if (!stripped) continue;
					try {
						await client.execute(stripped);
					} catch (stmtErr) {
						// Tolerate PRAGMA / transaction control statements that libSQL may reject
						const upper = stripped.toUpperCase();
						if (IGNORABLE.some((kw) => upper.startsWith(kw))) continue;
						throw stmtErr;
					}
				}

				return { message: "Database restored successfully from SQL dump." };
			} catch (err) {
				console.error("[DB-Restore] Failed:", err);
				return reply.code(500).send({ error: "Failed to restore database from SQL dump" });
			}
		},
	);

	// POST /admin/db-clear - Wipe all data from all tables
	fastify.post(
		"/admin/db-clear",
		{
			schema: { tags: ["Admin"] },
		},
		async (_request, reply) => {
			try {
				// Delete in safe order to respect foreign keys
				await db.delete(parcelEvents);
				await db.delete(parcels);
				await db.delete(orders);
				await db.delete(credentials);
				return { message: "All data cleared successfully" };
			} catch (err) {
				console.error("[DB-Clear] Failed:", err);
				return reply.code(500).send({ error: "Failed to clear database" });
			}
		},
	);

	// POST /admin/ingest-emails - Upload a .eml file or .zip archive to ingest parcels/orders
	fastify.post(
		"/admin/ingest-emails",
		{
			schema: { tags: ["Admin"] },
		},
		async (request: any, reply) => {
			try {
				const data = await request.file();
				if (!data) {
					return reply.code(400).send({ error: "No file uploaded" });
				}

				const fileBuffer = await data.toBuffer();
				console.log(`[IngestEmails] Received file: ${data.filename}, size: ${fileBuffer.length} bytes`);
				const filename = data.filename.toLowerCase();

				// Load rules first to ensure they are up to date
				await loadRemoteRules().catch((err) => {
					console.error("[IngestEmails] Failed to load remote rules:", err);
				});

				interface EmlItem {
					name: string;
					content: string;
				}

				const emlFiles: EmlItem[] = [];

				if (filename.endsWith(".zip")) {
					try {
						const zip = new AdmZip(fileBuffer);
						const zipEntries = zip.getEntries();
						for (const entry of zipEntries) {
							if (!entry.isDirectory && entry.entryName.toLowerCase().endsWith(".eml")) {
								emlFiles.push({
									name: entry.entryName,
									content: entry.getData().toString("utf-8"),
								});
							}
						}
					} catch (zipErr: any) {
						return reply.code(400).send({ error: `Failed to read zip archive: ${zipErr.message || zipErr}` });
					}
				} else if (filename.endsWith(".eml")) {
					emlFiles.push({
						name: data.filename,
						content: fileBuffer.toString("utf-8"),
					});
				} else {
					return reply.code(400).send({ error: "Invalid file type. Please upload a .eml file or a .zip archive containing .eml files." });
				}

				if (emlFiles.length === 0) {
					return reply.code(400).send({ error: "No .eml files found in the upload." });
				}

				let processedCount = 0;
				let orderCount = 0;
				let parcelCount = 0;

				for (const item of emlFiles) {
					try {
						const mail = await simpleParser(item.content);
						const from = mail.from?.value[0]?.address || "";
						const subject = mail.subject || "";
						const text = mail.text || EmailParser.extractBody(mail.html || "");

						const parser = new TrackingParser(from, subject, text);
						const trackingData = parser.parse();

						if (!trackingData) continue;

						let dbOrderId: number | null = null;
						let dbParcelId: number | null = null;

						const platformName = trackingData.platform?.name || "Unknown";
						const orderNo = trackingData.platform?.order_number;

						if (orderNo) {
							const existingOrder = await db
								.select()
								.from(orders)
								.where(and(eq(orders.orderNumber, orderNo), eq(orders.source, platformName)))
								.limit(1);

							if (existingOrder.length > 0) {
								dbOrderId = existingOrder[0].id;
							} else {
								const newOrder = await db
									.insert(orders)
									.values({
										source: platformName,
										orderNumber: orderNo,
										status: trackingData.type || "ordered",
										placedAt: mail.date || null,
										addedAt: new Date(),
										updatedAt: new Date(),
									})
									.returning();
								dbOrderId = newOrder[0].id;
								orderCount++;
							}
						}

						const trackingNumber = trackingData.courier?.tracking_number;
						const courierName = trackingData.courier?.name || platformName;

						if (trackingNumber) {
							const existingParcel = await db
								.select()
								.from(parcels)
								.where(eq(parcels.trackingNumber, trackingNumber))
								.limit(1);

							if (existingParcel.length > 0) {
								dbParcelId = existingParcel[0].id;
							} else {
								const newParcel = await db
									.insert(parcels)
									.values({
										trackingNumber,
										name: trackingData.items?.[0]?.name || null,
										courier: courierName,
										status: trackingData.type || "ordered",
										addedAt: new Date(),
										updatedAt: new Date(),
									})
									.returning();
								dbParcelId = newParcel[0].id;
								parcelCount++;

								// Trigger background track update
								trackAndUpdateParcel(dbParcelId).catch((err) => {
									console.error(`[UploadAutoTrack] Failed to track parcel ${dbParcelId}:`, err);
								});
							}
						}

						if (dbOrderId && dbParcelId) {
							await db.update(parcels).set({ orderId: dbOrderId }).where(eq(parcels.id, dbParcelId));
						}

						processedCount++;
					} catch (parseErr: any) {
						console.error(`[IngestEmails] Failed to process ${item.name}:`, parseErr.message || parseErr);
					}
				}

				return {
					message: `Successfully processed ${processedCount} of ${emlFiles.length} email(s).`,
					processedCount,
					orderCount,
					parcelCount,
				};
			} catch (err: any) {
				console.error("[IngestEmails] Failed:", err);
				return reply.code(500).send({ error: `Ingestion failed: ${err.message || err}` });
			}
		},
	);
}
