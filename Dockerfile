# ── Hovod All-in-One Image ──────────────────────────────────
# Bundles API, Worker, Dashboard, Redis, and MariaDB.
# S3-compatible storage is always external.
#
# Modes:
#   All-in-one:  just set S3 credentials, everything else embedded
#   Hybrid:      set DATABASE_URL and/or REDIS_URL to use external services
#
# Data persistence: mount a volume at /data
#   /data/mysql   — MariaDB data (when using embedded DB)
#   /data/redis   — Redis AOF/RDB (when using embedded Redis)

# ── Build stage ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy package manifests first for layer caching
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci

# Copy source and build
COPY packages packages
COPY apps apps
RUN npm run -w @hovod/db build \
 && npm run -w @hovod/api build \
 && npm run -w @hovod/worker build

# Build dashboard with empty API URL (same-origin in standalone mode)
ENV VITE_API_BASE_URL=""
RUN npm run -w @hovod/dashboard build

# ── Runtime stage ────────────────────────────────────────────
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      redis-server \
      mariadb-server \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for running the application
RUN groupadd -r hovod && useradd -r -g hovod -m hovod

WORKDIR /app

# Copy node_modules and package manifests
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json

# Copy built packages
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/package.json packages/db/package.json

# Copy API
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json

# Copy Worker
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/worker/package.json apps/worker/package.json

# Copy Dashboard (served by API via @fastify/static)
COPY --from=build /app/apps/dashboard/dist apps/dashboard/dist

# Entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Default data directory (owned by hovod for embedded services)
RUN mkdir -p /data && chown -R hovod:hovod /data

EXPOSE 3000

VOLUME ["/data"]

ENTRYPOINT ["/entrypoint.sh"]
