# Docker Deployment Guide

Hovod provides multiple deployment modes, from a single `docker run` command to a fully split production architecture. This guide covers every option with architecture diagrams, configuration, and scaling advice.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Deployment Modes](#deployment-modes)
  - [Mode 1: All-in-One (Simplest)](#mode-1-all-in-one-simplest)
  - [Mode 2: All-in-One + External Database](#mode-2-all-in-one--external-database)
  - [Mode 3: Docker Compose — Split Services](#mode-3-docker-compose--split-services)
  - [Mode 4: Production — Full Split](#mode-4-production--full-split)
- [Dockerfiles Reference](#dockerfiles-reference)
- [Environment Variables](#environment-variables)
- [Scaling](#scaling)
- [Volumes & Data Persistence](#volumes--data-persistence)
- [Building from Source](#building-from-source)
- [Networking & Ports](#networking--ports)

---

## Architecture Overview

Hovod is composed of 4 logical services that connect to 3 infrastructure backends:

```
                          ┌─────────────────────────────────────────────┐
                          │              Hovod Platform                 │
                          │                                             │
  Browser ───────────────>│  ┌───────────┐         ┌───────────────┐   │
                          │  │ Dashboard │────────>│   API Server  │   │
                          │  │ (React)   │         │   (Fastify)   │   │
                          │  └───────────┘         └───────┬───────┘   │
                          │                                │           │
                          │                          BullMQ job        │
                          │                                │           │
                          │                        ┌───────▼───────┐   │
                          │                        │    Worker     │   │
                          │                        │   (FFmpeg)    │   │
                          │                        └───────┬───────┘   │
                          └────────────────────────────────┼───────────┘
                                                           │
                    ┌──────────────────────────────────────┼────────────────┐
                    │              Infrastructure                          │
                    │                                                       │
                    │  ┌─────────┐    ┌─────────┐    ┌──────────────────┐  │
                    │  │  MySQL  │    │  Redis  │    │  S3 Storage     │  │
                    │  │  (state)│    │ (queue) │    │  (videos, HLS)  │  │
                    │  └─────────┘    └─────────┘    └──────────────────┘  │
                    └──────────────────────────────────────────────────────┘
```

### Data Flow

```
1. Upload                          2. Transcode                     3. Playback

Client ──POST──> API               API ──job──> Redis                Browser ──GET──> S3
                  │                              │                     (direct HLS streaming,
                  ▼                              ▼                      API not involved)
          S3 (source upload)              Worker picks up
          MySQL (asset record)                   │
                                                 ▼
                                          FFmpeg transcode
                                          (360p/720p/1080p)
                                                 │
                                                 ▼
                                          S3 (HLS segments)
                                          MySQL (status → ready)
```

**Key design**: Video playback is served **directly from S3**. The API only handles metadata and coordination. This means S3 absorbs all bandwidth, and the API stays lightweight.

---

## Deployment Modes

### Mode 1: All-in-One (Simplest)

**Best for**: Getting started, small teams, personal use, VPS/single-server deployments.

Everything runs in a single container. MariaDB and Redis are embedded and managed automatically. You only provide S3 credentials.

```
┌──────────────────────────────────────────────────────┐
│                  Hovod Container                     │
│                  (port 3000)                         │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  entrypoint.sh (process orchestrator)          │  │
│  │                                                │  │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │  │
│  │  │ MariaDB  │  │  Redis   │  │   Worker    │  │  │
│  │  │ (auto)   │  │  (auto)  │  │  (FFmpeg)   │  │  │
│  │  └──────────┘  └──────────┘  └─────────────┘  │  │
│  │                                                │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  API + Dashboard (foreground process)    │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  /data (volume)                                      │
│  ├── mysql/    MariaDB data files                    │
│  └── redis/    Redis persistence                     │
└──────────────────────────────────────────────────────┘
           │
           ▼
    S3 Storage (external)
```

```bash
docker run -d \
  --name hovod \
  --restart unless-stopped \
  -p 3000:3000 \
  -v hovod-data:/data \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET=my-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... \
  -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=https://my-bucket.s3.amazonaws.com \
  -e S3_FORCE_PATH_STYLE=false \
  synapsr/hovod
```

**What happens**:
- `entrypoint.sh` starts MariaDB, waits for it to be ready, creates the database
- Starts Redis with persistence (`save 60 1`)
- Starts the Worker process in the background
- Starts the API (serves the Dashboard SPA) in the foreground
- Graceful shutdown on `SIGTERM`/`SIGINT` stops all processes

**Characteristics**:
| Aspect | Detail |
|--------|--------|
| Image | `synapsr/hovod` (all-in-one) |
| Port | 3000 (API + Dashboard) |
| Volume | `/data` (MySQL + Redis) |
| MySQL | Embedded MariaDB, localhost only |
| Redis | Embedded, localhost only, persistence enabled |
| Worker | Single process, hardware-adaptive concurrency |
| Dashboard | Served by API via `@fastify/static` (same origin) |

---

### Mode 2: All-in-One + External Database

**Best for**: Production single-server, when you want managed MySQL (RDS, PlanetScale, etc.) or managed Redis (ElastiCache, Upstash, etc.).

Same image as Mode 1, but the entrypoint **skips** embedded services when their URL is provided.

```
┌──────────────────────────────────────┐
│          Hovod Container             │
│          (port 3000)                 │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  API + Dashboard              │  │
│  │  Worker (FFmpeg)              │  │
│  └────────────────────────────────┘  │
│                                      │
│  (no embedded DB or Redis)           │
└──────────┬───────────────────────────┘
           │
     ┌─────┼──────────────┐
     │     │              │
     ▼     ▼              ▼
  MySQL  Redis       S3 Storage
 (managed) (managed)  (external)
```

```bash
docker run -d \
  --name hovod \
  --restart unless-stopped \
  -p 3000:3000 \
  -e DATABASE_URL=mysql://user:pass@rds-host:3306/hovod \
  -e REDIS_URL=redis://elasticache-host:6379 \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET=my-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... \
  -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=https://my-bucket.s3.amazonaws.com \
  -e S3_FORCE_PATH_STYLE=false \
  synapsr/hovod
```

You can also mix: use external MySQL with embedded Redis, or vice versa. Only set the env vars for services you want external.

```bash
# External MySQL, embedded Redis
-e DATABASE_URL=mysql://user:pass@rds-host:3306/hovod
# (omit REDIS_URL → embedded Redis starts automatically)
```

---

### Mode 3: Docker Compose — Split Services

**Best for**: Local development, staging, teams who want to inspect each service independently.

Each service runs in its own container. MySQL, Redis, and MinIO run as separate containers.

```
┌────────────────────────────── Docker Network ──────────────────────────────┐
│                                                                            │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌────────────────────┐   │
│  │  MySQL   │    │  Redis   │    │  MinIO   │    │    MinIO Init     │   │
│  │  8.4     │    │  7       │    │  (S3)    │    │  (create bucket)  │   │
│  │  :3306   │    │  :6379   │    │  :9000   │    │  (one-shot)       │   │
│  └────┬─────┘    └────┬─────┘    └────┬─────┘    └────────────────────┘   │
│       │               │               │                                    │
│       └───────────────┼───────────────┘                                    │
│                       │                                                    │
│              ┌────────▼────────┐                                          │
│              │   API Server   │◄──────── ┌──────────────┐                │
│              │   :3000→3002   │          │  Dashboard   │                │
│              └────────┬───────┘          │  :3001→3003  │                │
│                       │                  └──────────────┘                 │
│                 BullMQ job                                                │
│                       │                                                    │
│              ┌────────▼────────┐                                          │
│              │    Worker      │                                           │
│              │   (FFmpeg)     │                                           │
│              │   no port      │                                           │
│              └────────────────┘                                           │
│                                                                            │
│  Shared volumes: uploads (API ↔ Worker), mysql-data, minio-data          │
└────────────────────────────────────────────────────────────────────────────┘
```

```bash
git clone https://github.com/Synapsr/Hovod.git && cd Hovod
cp .env.example .env
docker compose up -d --build
```

| Service | Internal port | External port | Purpose |
|---------|--------------|---------------|---------|
| `mysql` | 3306 | 3306 | Database |
| `redis` | 6379 | 6379 | Job queue |
| `minio` | 9000 / 9001 | 9000 / 9001 | S3 storage / web console |
| `api` | 3000 | **3002** | REST API |
| `worker` | — | — | Transcode worker |
| `dashboard` | 3001 | **3003** | React SPA |

**Access points**:
- Dashboard: http://localhost:3003
- API: http://localhost:3002
- MinIO Console: http://localhost:9001

---

### Mode 4: Production — Full Split

**Best for**: High-volume production, Kubernetes, horizontal scaling, when you need multiple workers.

Each Hovod service uses its own dedicated Dockerfile. Infrastructure (MySQL, Redis, S3) is managed externally.

```
                         Load Balancer / Reverse Proxy
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                    ▼               ▼               ▼
             ┌───────────┐  ┌───────────┐   ┌─────────────┐
             │ Dashboard │  │ API       │   │ API         │
             │ (CDN/     │  │ replica 1 │   │ replica 2   │
             │  static)  │  └─────┬─────┘   └──────┬──────┘
             └───────────┘        │                 │
                                  └────────┬────────┘
                                           │
                              ┌────────────▼────────────┐
                              │    Redis (managed)      │
                              │  BullMQ job queue       │
                              └────────────┬────────────┘
                                           │
                          ┌────────────────┼────────────────┐
                          │                │                │
                   ┌──────▼──────┐  ┌──────▼──────┐  ┌─────▼───────┐
                   │  Worker 1  │  │  Worker 2  │  │  Worker 3  │
                   │  (FFmpeg)  │  │  (FFmpeg)  │  │  (FFmpeg)  │
                   │  4 cores   │  │  4 cores   │  │  4 cores   │
                   └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
                          │               │               │
                          └───────────────┼───────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
                    ▼                     ▼                     ▼
             ┌───────────┐       ┌───────────────┐     ┌───────────┐
             │  MySQL    │       │   S3 / CDN    │     │  Redis    │
             │ (managed) │       │  (video       │     │ (managed) │
             │ (RDS etc) │       │   delivery)   │     │           │
             └───────────┘       └───────────────┘     └───────────┘
```

#### API

```bash
docker build -f apps/api/Dockerfile -t hovod-api .

docker run -d \
  --name hovod-api \
  -p 3000:3000 \
  -e DATABASE_URL=mysql://user:pass@db-host:3306/hovod \
  -e REDIS_URL=redis://redis-host:6379 \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET=my-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... \
  -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=https://cdn.example.com \
  -e S3_FORCE_PATH_STYLE=false \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  hovod-api
```

#### Worker (scale horizontally)

```bash
docker build -f apps/worker/Dockerfile -t hovod-worker .

# Run as many workers as needed — they share the same Redis queue
docker run -d --name hovod-worker-1 \
  -e DATABASE_URL=mysql://user:pass@db-host:3306/hovod \
  -e REDIS_URL=redis://redis-host:6379 \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET=my-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... \
  -e S3_SECRET_ACCESS_KEY=... \
  hovod-worker

docker run -d --name hovod-worker-2 \
  -e DATABASE_URL=mysql://user:pass@db-host:3306/hovod \
  -e REDIS_URL=redis://redis-host:6379 \
  -e S3_ENDPOINT=... \
  # ... same S3 env vars
  hovod-worker
```

Each worker auto-detects its own CPU/RAM and adjusts concurrency. See [Scaling](#scaling).

#### Dashboard

```bash
docker build -f apps/dashboard/Dockerfile \
  --build-arg VITE_API_BASE_URL=https://api.example.com \
  -t hovod-dashboard .

docker run -d --name hovod-dashboard -p 3001:3001 hovod-dashboard
```

> **Tip**: In production, serve the Dashboard build output (`apps/dashboard/dist/`) from a CDN or static file server (Nginx, Caddy, Cloudflare Pages, etc.) instead of running a Node.js container for it.

---

## Dockerfiles Reference

| File | Image | Contains | Port | Size |
|------|-------|----------|------|------|
| `Dockerfile` | `synapsr/hovod` | API + Worker + Dashboard + MariaDB + Redis + FFmpeg | 3000 | ~600 MB |
| `apps/api/Dockerfile` | `hovod-api` | API server only | 3000 | ~200 MB |
| `apps/worker/Dockerfile` | `hovod-worker` | Worker + FFmpeg | — | ~350 MB |
| `apps/dashboard/Dockerfile` | `hovod-dashboard` | React SPA + serve | 3001 | ~150 MB |

All Dockerfiles use **multi-stage builds** (build → runtime) for minimal image sizes. Build artifacts and `node_modules` are pruned.

---

## Environment Variables

### Required (all modes)

| Variable | Description |
|----------|-------------|
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_REGION` | S3 region |
| `S3_BUCKET` | S3 bucket name |
| `S3_ACCESS_KEY_ID` | S3 access key |
| `S3_SECRET_ACCESS_KEY` | S3 secret key |
| `S3_PUBLIC_BASE_URL` | Public URL to access S3 objects (for HLS playback) |

### Required (split mode only)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MySQL connection string (`mysql://user:pass@host:3306/db`) |
| `REDIS_URL` | Redis connection string (`redis://host:6379`) |
| `JWT_SECRET` | Secret for JWT auth tokens (min 32 chars, `openssl rand -hex 32`). In all-in-one mode it is generated on first boot and persisted in `/data/.hovod-secrets` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | API/dashboard port |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style S3 URLs (set `false` for AWS S3) |
| `S3_PUBLIC_ENDPOINT` | same as `S3_ENDPOINT` | Public S3 endpoint for browser uploads |
| `CORS_ORIGIN` | `*` | Allowed CORS origins (comma-separated) |
| `DASHBOARD_URL` | `http://localhost:3000` | Base URL for embed player URLs |

### Scaling (auto-detected, override via env)

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CONCURRENCY` | auto | Concurrent transcode jobs per worker |
| `FFMPEG_THREADS` | auto | Threads per FFmpeg process |
| `DB_POOL_SIZE` | auto | MySQL connection pool size |

The worker logs its computed config at startup:

```
[worker] Hardware-adaptive config:
  CPU cores:      8
  Total RAM:      16.0 GB
  Concurrency:    2 job(s)
  FFmpeg threads: 4 per job
  DB pool size:   6
```

See the [Scaling](#scaling) section below for formulas and recommendations.

---

## Scaling

### How auto-detection works

At startup, the worker reads CPU core count and total RAM to compute:

```
Concurrency   = max(1, min( floor((RAM - 1GB) / 1.5GB), floor(cores / 4) ))
FFmpeg threads = max(1, floor(cores / concurrency))
DB pool        = max(5, concurrency * 2 + 2)
```

| Machine | Concurrency | FFmpeg threads | DB pool |
|---------|-------------|----------------|---------|
| 2 cores, 4 GB | 1 job | 2 | 5 |
| 4 cores, 8 GB | 1 job | 4 | 5 |
| 8 cores, 16 GB | 2 jobs | 4 | 6 |
| 16 cores, 32 GB | 4 jobs | 4 | 10 |
| 32 cores, 64 GB | 8 jobs | 4 | 18 |

### Horizontal scaling (multiple workers)

Workers are stateless. Run multiple instances against the same Redis queue to increase throughput:

```
                    ┌────────────────────┐
                    │   Redis (BullMQ)   │
                    │   shared queue     │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
       ┌──────▼──────┐ ┌─────▼───────┐ ┌─────▼───────┐
       │  Worker 1  │ │  Worker 2  │ │  Worker 3  │
       │  8 cores   │ │  4 cores   │ │  16 cores  │
       │  2 jobs    │ │  1 job     │ │  4 jobs    │
       └────────────┘ └─────────────┘ └─────────────┘
                              │
              Total throughput: 7 concurrent transcodes
```

Each worker auto-detects its own hardware independently. Heterogeneous machines work fine.

```bash
# Scale workers in Docker Compose
docker compose up -d --scale worker=3

# Or run separate containers
docker run -d --name worker-1 -e ... hovod-worker
docker run -d --name worker-2 -e ... hovod-worker
docker run -d --name worker-3 -e ... hovod-worker
```

### API scaling

The API is stateless (all state lives in MySQL/Redis). Run multiple replicas behind a load balancer:

```bash
docker compose up -d --scale api=2
```

> **Note**: The Dashboard in split mode is a static SPA. It can be served from a CDN without a Node.js runtime.

---

## Volumes & Data Persistence

### All-in-One mode

| Path | Content | Critical |
|------|---------|----------|
| `/data/mysql/` | MariaDB data files | Yes — losing this loses all metadata |
| `/data/redis/` | Redis RDB/AOF snapshots | Low — only job queue state |

```bash
docker run -v hovod-data:/data ...
```

### Split mode (Docker Compose)

| Volume | Used by | Content |
|--------|---------|---------|
| `mysql-data` | MySQL | Database files |
| `minio-data` | MinIO | Video files + HLS output |
| `uploads` | API + Worker | Temporary upload buffer (shared) |

> The `uploads` volume is only needed when using the direct upload endpoint (`PUT /v1/assets/:id/upload`). If you use pre-signed S3 URLs for uploads (`POST /v1/assets/:id/upload-url`), the volume can be omitted.

---

## Building from Source

```bash
git clone https://github.com/Synapsr/Hovod.git && cd Hovod

# All-in-one image
docker build -t hovod .

# Individual images
docker build -f apps/api/Dockerfile -t hovod-api .
docker build -f apps/worker/Dockerfile -t hovod-worker .
docker build -f apps/dashboard/Dockerfile \
  --build-arg VITE_API_BASE_URL=https://api.example.com \
  -t hovod-dashboard .
```

**Build order**: The Dockerfiles handle the build order internally (`@hovod/db` is built first). No manual steps required.

---

## Networking & Ports

### All-in-One

| Port | Service |
|------|---------|
| **3000** | API + Dashboard (single port) |

MariaDB and Redis bind to `127.0.0.1` (localhost only, not exposed).

### Docker Compose (default)

| External port | Internal port | Service |
|--------------|---------------|---------|
| **3002** | 3000 | API |
| **3003** | 3001 | Dashboard |
| 3306 | 3306 | MySQL |
| 6379 | 6379 | Redis |
| 9000 | 9000 | MinIO S3 API |
| 9001 | 9001 | MinIO Console |

### Internal communication

```
Dashboard ──HTTP──> API (:3000)
API ──mysql2──> MySQL (:3306)
API ──ioredis──> Redis (:6379)
API ──BullMQ──> Redis (:6379) ──> Worker
Worker ──mysql2──> MySQL (:3306)
Worker ──AWS SDK──> S3 (:9000)
Browser ──HLS──> S3 (direct, public URLs)
```

---

## Quick Reference

| I want to... | Use |
|--------------|-----|
| Try Hovod in 30 seconds | [Mode 1: All-in-One](#mode-1-all-in-one-simplest) |
| Run in production on a VPS | [Mode 2: All-in-One + External DB](#mode-2-all-in-one--external-database) |
| Develop locally | [Mode 3: Docker Compose](#mode-3-docker-compose--split-services) |
| Scale for high volume | [Mode 4: Full Split](#mode-4-production--full-split) |
| Add more transcode capacity | [Scaling: multiple workers](#horizontal-scaling-multiple-workers) |
