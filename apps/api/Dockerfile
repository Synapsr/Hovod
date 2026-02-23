FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY apps/api/package.json ./apps/api/package.json
RUN npm install

FROM base AS build
COPY packages ./packages
COPY apps/api ./apps/api
WORKDIR /app
RUN npm run -w @hovod/db build && npm run -w @hovod/api build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN mkdir -p /data/uploads && chown -R node:node /data/uploads
WORKDIR /app/apps/api
USER node
CMD ["node", "dist/index.js"]
