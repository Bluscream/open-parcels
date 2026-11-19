import { z } from "zod";
import { PARCEL_LABEL_MODES } from "../../domain/parcel.js";
import { appendEvent } from "../../events/bus.js";
import { GeocodeError } from "../../geo/geocoder.js";
import type { Services } from "../../services.js";
import { homeSchema } from "../../settings/store.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";

const settingsSchema = z.object({
  home: homeSchema.nullable(),
  parcel_label: z
    .enum(PARCEL_LABEL_MODES)
    .describe(
      "How a parcel without a label is named: its tracking code, or its item names (max 100 characters).",
    ),
});

/** Every parcel's display name may change: clients re-read (the HA integration resyncs). */
async function announce(services: Services, what: string): Promise<void> {
  await appendEvent(services.db, services.clock, {
    type: "settings.updated",
    parcelId: null,
    payload: { changed: what },
  });
}

function current(services: Services): z.infer<typeof settingsSchema> {
  return { home: services.settings.home, parcel_label: services.settings.labelMode };
}

export function registerSettingsRoutes(app: TypedApp, services: Services): void {
  app.get(
    "/api/v1/settings",
    {
      preHandler: requireScope("read"),
      schema: {
        tags: ["settings"],
        summary: "The app's settings.",
        response: { 200: settingsSchema },
      },
    },
    () => current(services),
  );

  app.put(
    "/api/v1/settings/home",
    {
      preHandler: requireScope("write"),
      schema: {
        tags: ["settings"],
        summary: "Set the home location.",
        body: homeSchema,
        response: { 200: homeSchema },
      },
    },
    async (request) => {
      await services.settings.setHome(request.body);
      await announce(services, "home");
      return request.body;
    },
  );

  app.delete(
    "/api/v1/settings/home",
    {
      preHandler: requireScope("write"),
      schema: { tags: ["settings"], summary: "Forget the home location." },
    },
    async (_request, reply) => {
      await services.settings.setHome(null);
      await announce(services, "home");
      return reply.code(204).send();
    },
  );

  app.put(
    "/api/v1/settings/parcel-label",
    {
      preHandler: requireScope("write"),
      schema: {
        tags: ["settings"],
        summary: "Choose how parcels without a label are named.",
        body: z.object({ parcel_label: z.enum(PARCEL_LABEL_MODES) }),
        response: { 200: settingsSchema },
      },
    },
    async (request) => {
      await services.settings.setLabelMode(request.body.parcel_label);
      await announce(services, "parcel_label");
      return current(services);
    },
  );

  app.get(
    "/api/v1/geocode",
    {
      preHandler: requireScope("write"),
      schema: {
        tags: ["settings"],
        summary: "Look up an address or place (OpenStreetMap Nominatim, through this server).",
        querystring: z.object({ q: z.string().trim().min(2).max(200) }),
        response: {
          200: z.array(
            z.object({ label: z.string(), latitude: z.number(), longitude: z.number() }),
          ),
          400: errorBodySchema,
          502: errorBodySchema,
        },
      },
    },
    async (request) => {
      const language = request.headers["accept-language"]?.split(",", 1)[0]?.trim();
      try {
        const places = await services.geocoder.search(request.query.q, language);
        return places.map((place) => ({ ...place }));
      } catch (error) {
        if (error instanceof GeocodeError) {
          throw new ApiError(502, "geocode_failed", error.message);
        }
        throw error;
      }
    },
  );
}
