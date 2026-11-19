import { z } from "zod";
import { isoNow } from "../../clock.js";
import { GeocodeError } from "../../geo/geocoder.js";
import type { Services } from "../../services.js";
import type { TypedApp } from "../app.js";
import { requireScope } from "../auth-plugin.js";
import { ApiError, errorBodySchema } from "../errors.js";

const HOME_SETTING = "home";

const homeSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    label: z.string().trim().max(300).nullable().default(null),
  })
  .describe("Where parcels go: centres the maps and gives distances. Set by the user.");
type Home = z.infer<typeof homeSchema>;

const settingsSchema = z.object({ home: homeSchema.nullable() });

/** The user's home location, or null when none is set (or the stored value is unreadable). */
export async function readHome(services: Services): Promise<Home | null> {
  const row = await services.db
    .selectFrom("settings")
    .select("value")
    .where("key", "=", HOME_SETTING)
    .executeTakeFirst();
  if (row === undefined) return null;
  const parsed = homeSchema.safeParse(JSON.parse(row.value));
  return parsed.success ? parsed.data : null;
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
    async () => ({ home: await readHome(services) }),
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
      const home = request.body;
      const now = isoNow(services.clock);
      await services.db
        .insertInto("settings")
        .values({ key: HOME_SETTING, value: JSON.stringify(home), updated_at: now })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({ value: JSON.stringify(home), updated_at: now }),
        )
        .execute();
      return home;
    },
  );

  app.delete(
    "/api/v1/settings/home",
    {
      preHandler: requireScope("write"),
      schema: { tags: ["settings"], summary: "Forget the home location." },
    },
    async (_request, reply) => {
      await services.db.deleteFrom("settings").where("key", "=", HOME_SETTING).execute();
      return reply.code(204).send();
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
