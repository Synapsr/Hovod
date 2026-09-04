# syntax=docker/dockerfile:1.7
# ── Hovod image ──────────────────────────────────────────────────────────────
# One image, three roles (HOVOD_ROLE):
#   allinone (default)  API + worker + dashboard, with embedded MariaDB and Redis
#                       unless DATABASE_URL / REDIS_URL point at external ones.
#   api                 API + dashboard only (external DB/Redis required)
#   worker              transcoding worker only (external DB/Redis required)
#
# Processes are supervised by s6-overlay: crashes restart automatically, boot
# order is db/redis → api/worker, shutdown is the reverse.
#
# Data persistence: mount a volume at /data
#   /data/mysql            MariaDB data (embedded DB)
#   /data/redis            Redis snapshot (embedded Redis)
#   /data/.hovod-secrets   generated secrets (JWT_SECRET, MariaDB root password)
#   /data/backups          hovod-backup output
#   /data/tmp              FFmpeg scratch space
#   /data/uploads          direct-upload buffer

ARG NODE_IMAGE=node:22-bookworm-slim
ARG S6_OVERLAY_VERSION=3.2.3.2

# ── s6-overlay (downloaded and checksum-verified in a throwaway stage) ───────
FROM debian:bookworm-slim AS s6
ARG S6_OVERLAY_VERSION
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) S6_ARCH=x86_64;  S6_ARCH_SHA256=e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408 ;; \
      arm64) S6_ARCH=aarch64; S6_ARCH_SHA256=b17f17a82e7a515c682a91edaf2ffdabb73f891981b6c1fd712115693a2f8b4c ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    S6_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12; \
    base="https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}"; \
    echo "s6-overlay v${S6_OVERLAY_VERSION} for ${TARGETARCH} (${S6_ARCH})"; \
    curl -fsSL -o /tmp/s6-noarch.tar.xz "${base}/s6-overlay-noarch.tar.xz"; \
    curl -fsSL -o /tmp/s6-arch.tar.xz   "${base}/s6-overlay-${S6_ARCH}.tar.xz"; \
    echo "${S6_NOARCH_SHA256}  /tmp/s6-noarch.tar.xz" | sha256sum -c -; \
    echo "${S6_ARCH_SHA256}  /tmp/s6-arch.tar.xz"     | sha256sum -c -; \
    mkdir -p /s6; \
    tar -C /s6 -Jxpf /tmp/s6-noarch.tar.xz; \
    tar -C /s6 -Jxpf /tmp/s6-arch.tar.xz

# ── Build (all workspaces, dev dependencies included) ────────────────────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci
COPY packages packages
COPY apps apps
RUN npm run -w @hovod/db build \
 && npm run -w @hovod/api build \
 && npm run -w @hovod/worker build
# Same-origin dashboard: the API serves the SPA, so no API base URL is baked in
ENV VITE_API_BASE_URL=""
RUN npm run -w @hovod/dashboard build

# ── Runtime dependencies only (no dev deps, no dashboard deps) ───────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --ignore-scripts -w @hovod/db -w @hovod/api -w @hovod/worker \
 && npm cache clean --force \
 # npm may nest a workspace-specific copy of a dependency (e.g. ioredis) under
 # apps/*/node_modules — make sure the directories exist so the COPY below
 # succeeds whether or not that happened.
 && mkdir -p packages/db/node_modules apps/api/node_modules apps/worker/node_modules

# ── Runtime image ────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ARG S6_OVERLAY_VERSION
ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      redis-server \
      mariadb-server \
      mariadb-client \
 && rm -rf /var/lib/apt/lists/* \
 # the package initialises /var/lib/mysql; our data lives in /data/mysql
 && rm -rf /var/lib/mysql/* /var/lib/redis/* \
 # no package manager needed at runtime
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && groupadd -r hovod && useradd -r -g hovod -m -d /home/hovod -s /usr/sbin/nologin hovod

# s6-overlay
COPY --from=s6 /s6 /

WORKDIR /app

# Runtime node_modules (root + per-workspace nested copies)
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/packages/db/node_modules packages/db/node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=deps /app/apps/worker/node_modules apps/worker/node_modules
COPY --from=build /app/package.json package.json

# Built packages
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/packages/db/package.json packages/db/package.json
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/apps/worker/package.json apps/worker/package.json
# Dashboard (served by the API via @fastify/static)
COPY --from=build /app/apps/dashboard/dist apps/dashboard/dist

# Service definitions, boot hook, helper scripts, backup tooling
COPY docker/rootfs/ /
COPY scripts/hovod-backup scripts/hovod-restore /usr/local/bin/
RUN chmod 755 /usr/local/bin/hovod-backup /usr/local/bin/hovod-restore /usr/local/bin/hovod-healthcheck \
             /etc/s6-overlay/scripts/hovod-stage2-hook /usr/local/lib/hovod/mariadb-init.sh \
             /etc/hovod/s6-rc.d/*/run /etc/hovod/s6-rc.d/*/data/check \
 # the runtime s6-rc profile is generated by the boot hook under /run
 && mkdir -p /etc/cont-profile.d && ln -s /run/hovod/profile /etc/cont-profile.d/hovod \
 && mkdir -p /data && chown hovod:hovod /data

ENV HOVOD_ROLE=allinone \
    NODE_ENV=production \
    PORT=3000 \
    # s6 tools (s6-svstat, s6-rc, ...) reachable from `docker exec`
    PATH="${PATH}:/command" \
    # s6-overlay: boot hook generates the service set, halt on boot failure,
    # wait up to 5 min for db/redis readiness, 5 s TERM→KILL grace at shutdown
    S6_STAGE2_HOOK=/etc/s6-overlay/scripts/hovod-stage2-hook \
    S6_RUNTIME_PROFILE=hovod \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=300000 \
    S6_KILL_GRACETIME=5000 \
    S6_KILL_FINISH_MAXTIME=10000

LABEL org.opencontainers.image.title="Hovod" \
      org.opencontainers.image.description="Self-hosted, open-source video platform. Upload, transcode, stream." \
      org.opencontainers.image.url="https://github.com/Synapsr/Hovod" \
      org.opencontainers.image.source="https://github.com/Synapsr/Hovod" \
      org.opencontainers.image.documentation="https://github.com/Synapsr/Hovod/blob/main/DOCKER.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Synapsr" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      io.hovod.s6-overlay.version="${S6_OVERLAY_VERSION}"

EXPOSE 3000
VOLUME ["/data"]
STOPSIGNAL SIGTERM

# Unhealthy when the API is down or cannot reach its database (worker role: process down)
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["/usr/local/bin/hovod-healthcheck"]

ENTRYPOINT ["/init"]
