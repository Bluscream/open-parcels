import { z } from "zod";
import { DIRECTIONS, parcelSchema, parcelStatusSchema } from "../../domain/parcel.js";
import { DuplicateParcelError } from "../../parcels/service.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema, notFound } from "../errors.js";

const idParams = z.object({ id: z.uuid() });

const booleanQuery = z.enum(["true", "false"]).transform((value) => value === "true");

export function registerParcelRoutes(app: TypedApp, services: Services): void {
  const read = requireScope("read");
  const write = requireScope("write");

  app.get(
    "/api/v1/parcels",
    {
      preHandler: read,
      schema: {
        tags: ["parcels"],
        summary: "List parcels, newest change first.",
        querystring: z.object({
          active: booleanQuery.optional(),
          status: parcelStatusSchema.optional(),
          carrier: z.string().max(64).optional(),
          include_archived: booleanQuery.optional(),
          include_history: booleanQuery.optional(),
          limit: z.coerce.number().int().min(1).max(1000).optional(),
        }),
        response: { 200: z.array(parcelSchema) },
      },
    },
    async (request) => {
      const query = request.query;
      return services.parcels.repository.list(
        {
          ...(query.active === undefined ? {} : { active: query.active }),
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.carrier === undefined ? {} : { carrier: query.carrier }),
          ...(query.include_archived === undefined
            ? {}
            : { includeArchived: query.include_archived }),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        },
        query.include_history === true,
      );
    },
  );

  app.get(
    "/api/v1/parcels/:id",
    {
      preHandler: read,
      schema: {
        tags: ["parcels"],
        summary: "One parcel with its full history.",
        params: idParams,
        response: { 200: parcelSchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const parcel = await services.parcels.repository.get(request.params.id);
      if (parcel === undefined) {
        throw notFound("The parcel");
      }
      return parcel;
    },
  );

  app.post(
    "/api/v1/parcels",
    {
      preHandler: write,
      schema: {
        tags: ["parcels"],
        summary: "Start tracking a code.",
        body: z.object({
          carrier: z.string().min(1).max(64),
          barcode: z.string().trim().min(4).max(64),
          direction: z.enum(DIRECTIONS).default("incoming"),
          label: z.string().max(120).nullable().default(null),
        }),
        response: { 201: parcelSchema, 409: errorBodySchema },
      },
    },
    async (request, reply) => {
      try {
        const parcel = await services.parcels.create(request.body);
        return await reply.code(201).send(parcel);
      } catch (error) {
        if (error instanceof DuplicateParcelError) {
          throw new ApiError(
            409,
            "duplicate",
            `This parcel is already tracked as ${error.existingId}.`,
          );
        }
        throw error;
      }
    },
  );

  app.patch(
    "/api/v1/parcels/:id",
    {
      preHandler: write,
      schema: {
        tags: ["parcels"],
        summary:
          "Rename, override the status, or archive a parcel. A manual status is never overwritten by carrier updates.",
        params: idParams,
        body: z.object({
          label: z.string().max(120).nullable().optional(),
          manual_status: parcelStatusSchema.nullable().optional(),
          archived: z.boolean().optional(),
        }),
        response: { 200: parcelSchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const body = request.body;
      const parcel = await services.parcels.update(request.params.id, {
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.manual_status === undefined ? {} : { manualStatus: body.manual_status }),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      });
      if (parcel === undefined) {
        throw notFound("The parcel");
      }
      return parcel;
    },
  );

  app.delete(
    "/api/v1/parcels/:id",
    {
      preHandler: write,
      schema: {
        tags: ["parcels"],
        summary: "Stop tracking and delete a parcel.",
        params: idParams,
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if (!(await services.parcels.delete(request.params.id))) {
        throw notFound("The parcel");
      }
      return reply.code(204).send(null);
    },
  );
}
