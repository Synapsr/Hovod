FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY apps/worker/package.json ./apps/worker/package.json
RUN npm install

FROM base AS build
COPY packages ./packages
COPY apps/worker ./apps/worker
WORKDIR /app
RUN npm run -w @hovod/db build && npm run -w @hovod/worker build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN mkdir -p /data/uploads && chown -R node:node /data/uploads
WORKDIR /app/apps/worker
USER node
CMD ["node", "dist/index.js"]
