import { z } from "zod";
import { ORDER_VIEWS, orderSchema } from "../../domain/order-lifecycle.js";
import { ORDER_PAGE_DEFAULT } from "../../orders/service.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { errorBodySchema, notFound } from "../errors.js";

const idParams = z.object({ id: z.uuid() });

const LIFECYCLE =
  "An order's `status` is derived from its parcels: `ordered` (nothing shipped yet), " +
  "`partly_shipped`, `shipped`, `partly_delivered`, `delivered`, or `problem` (a parcel not yet " +
  "delivered reports a problem or is returning). Archiving is automatic (`archive_mode: " +
  "automatic`): an order is archived once all its parcels are archived, and parcels archive " +
  "themselves after the retention window (`archiveAfterDays`) once delivered; an order that " +
  "never got a parcel is archived 30 days after it was placed. The owner can " +
  "archive by hand (`archived`) or keep an order out of the archive (`kept`).";

export function registerOrderRoutes(app: TypedApp, services: Services): void {
  const read = requireScope("read");
  const write = requireScope("write");

  app.get(
    "/api/v1/orders",
    {
      preHandler: read,
      schema: {
        tags: ["orders"],
        summary: "List orders with their items and parcels, newest first.",
        description:
          `${LIFECYCLE} \`view\`: \`open\` (default; not delivered, not archived), ` +
          "`delivered` (all parcels delivered, not archived), `archived`, or `all`. Pages of " +
          "`limit` orders (default 100) from `offset`; when another page follows, the response " +
          "carries the `X-Next-Offset` header.",
        querystring: z.object({
          view: z.enum(ORDER_VIEWS).default("open"),
          limit: z.coerce.number().int().min(1).max(500).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
        response: { 200: z.array(orderSchema) },
      },
    },
    async (request, reply) => {
      const limit = request.query.limit ?? ORDER_PAGE_DEFAULT;
      const offset = request.query.offset ?? 0;
      const page = await services.orders.list({ view: request.query.view, limit, offset });
      if (page.more) {
        void reply.header("x-next-offset", String(offset + limit));
      }
      return page.orders;
    },
  );

  app.get(
    "/api/v1/orders/:id",
    {
      preHandler: read,
      schema: {
        tags: ["orders"],
        summary: "One order with its items and parcels (status and location).",
        description: LIFECYCLE,
        params: idParams,
        response: { 200: orderSchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const order = await services.orders.get(request.params.id);
      if (order === undefined) {
        throw notFound("The order");
      }
      return order;
    },
  );

  app.patch(
    "/api/v1/orders/:id",
    {
      preHandler: write,
      schema: {
        tags: ["orders"],
        summary: "Rename an order, or archive it by hand.",
        description:
          "`label`: the order's own name, null for the shop's. `archived`: true archives it, " +
          "false keeps it out of the archive even when all its parcels are archived, null " +
          "returns it to automatic archiving. Parcels are not changed. Fires `order.updated`.",
        params: idParams,
        body: z.object({
          label: z.string().trim().max(120).nullable().optional(),
          archived: z.boolean().nullable().optional(),
        }),
        response: { 200: orderSchema, 404: errorBodySchema },
      },
    },
    async (request) => {
      const { label, archived } = request.body;
      const order = await services.orders.update(request.params.id, {
        ...(label === undefined ? {} : { label: label === "" ? null : label }),
        ...(archived === undefined ? {} : { archived }),
      });
      if (order === undefined) {
        throw notFound("The order");
      }
      return order;
    },
  );

  app.delete(
    "/api/v1/orders/:id",
    {
      preHandler: write,
      schema: {
        tags: ["orders"],
        summary: "Delete an order; its parcels are kept and unlinked.",
        description:
          "The order's lines go and its parcels stay tracked without it. The shop and order " +
          "number are remembered, so a shop source listing the order again does not re-create " +
          "it. Fires `order.deleted`.",
        params: idParams,
        response: { 204: z.null(), 404: errorBodySchema },
      },
    },
    async (request, reply) => {
      if (!(await services.orders.delete(request.params.id))) {
        throw notFound("The order");
      }
      return reply.code(204).send(null);
    },
  );
}
