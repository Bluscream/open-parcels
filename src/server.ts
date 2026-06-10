import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastifyWebsocket from "@fastify/websocket";
import dotenv from "dotenv";
import Fastify from "fastify";
import { apiRoutes } from "./api/routes";
import { loadRemoteRules, startRulesRefreshInterval } from "./services/ingest/rules-loader";

// Load environment variables
dotenv.config();
// In dev, .env.local overrides .env so local settings (e.g. local rules files) take effect
if (process.env.NODE_ENV !== "production") {
	dotenv.config({ path: ".env.local", override: true });
}

const server = Fastify({
	logger: true,
});

// Register plugins
server.register(cors, {
	origin: true, // adjust in production
});

server.register(fastifyWebsocket);

server.register(swagger, {
	openapi: {
		openapi: "3.0.0",
		info: {
			title: "OpenParcels API",
			description: "API for OpenParcels tracking service",
			version: "1.0.0",
		},
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
				},
				apiKey: {
					type: "apiKey",
					name: "token",
					in: "query",
				},
			},
		},
	},
});

server.register(swaggerUi, {
	routePrefix: "/docs",
	uiConfig: {
		docExpansion: "full",
		deepLinking: false,
	},
});

// Register routes
server.register(apiRoutes, { prefix: "/api/v1" });

// Serve frontend assets statically
const distPath = path.join(__dirname, "../frontend/dist");

// Serve /assets/* with wildcard routing
server.register(fastifyStatic, {
	root: path.join(distPath, "assets"),
	prefix: "/assets/",
	wildcard: true,
	decorateReply: false,
});

// Serve root files (index.html, favicon.ico, etc.) with wildcard routing
server.register(fastifyStatic, {
	root: distPath,
	prefix: "/",
	wildcard: true,
});

// Fallback for single-page application routes (e.g. /manage, /parcel/*)
server.setNotFoundHandler((_request, reply) => {
	return reply.sendFile("index.html");
});

const start = async () => {
	try {
		// Load remote email parsing rules
		await loadRemoteRules().catch(err => {
			console.error("Failed to load remote rules at startup:", err);
		});
		startRulesRefreshInterval();

		const port = parseInt(process.env.PORT || "3000", 10);
		await server.listen({ port, host: "0.0.0.0" });
		console.log(`Server listening on port ${port}`);
	} catch (err) {
		server.log.error(err);
		process.exit(1);
	}
};

start();
