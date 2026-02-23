FROM node:22-bookworm-slim AS base
WORKDIR /app
COPY package.json ./
COPY apps/dashboard/package.json ./apps/dashboard/package.json
RUN npm install

FROM base AS build
COPY apps/dashboard ./apps/dashboard
WORKDIR /app
ARG VITE_API_BASE_URL=http://localhost:3002
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run -w @hovod/dashboard build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/apps/dashboard ./apps/dashboard
RUN chown -R node:node /app
WORKDIR /app/apps/dashboard
USER node
CMD ["npm", "run", "start"]
