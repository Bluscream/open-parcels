# syntax=docker/dockerfile:1.10
#
# One image for amd64 and arm64 (the Home Assistant Pi is aarch64).
# Debian slim rather than Alpine: native modules ship glibc builds, and Playwright (for the
# optional browser variant) does not support musl.

ARG NODE_VERSION=26

# --- Build: compile TypeScript with the full toolchain -------------------------------------------
FROM node:${NODE_VERSION}-slim AS build
# Compilers for better-sqlite3 when no prebuilt binary matches this Node ABI and architecture.
RUN apt-get update \
 && apt-get install --no-install-recommends -y python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
RUN npm ci --workspace server --include-workspace-root
COPY server/ server/
RUN npm run build --workspace server

# --- Production dependencies only -----------------------------------------------------------------
FROM build AS deps
RUN rm -rf node_modules server/node_modules \
 && npm ci --workspace server --omit=dev

# --- Runtime ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data \
 && chown node:node /data
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/server/package.json ./server/package.json
COPY --from=build --chown=root:root /app/server/dist ./server/dist

ENV NODE_ENV=production \
    OPENPARCELS_DATA_DIR=/data \
    OPENPARCELS_PORT=3000

# Runs as the image's unprivileged `node` user (uid 1000). The application files are owned by root
# and read-only for it; /data is the only place it writes.
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OPENPARCELS_PORT||3000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/dist/main.js"]

LABEL org.opencontainers.image.title="open-parcels" \
      org.opencontainers.image.description="Self-hosted parcel and order tracking for every carrier, shop and mailbox." \
      org.opencontainers.image.source="https://github.com/Bluscream/open-parcels"
