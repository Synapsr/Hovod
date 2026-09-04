<div align="center">

# Hovod

### The Open-Source Video Platform

**Stop paying per-minute for video infrastructure. Own your video pipeline.**

[![Docker](https://img.shields.io/badge/Docker-synapsr%2Fhovod-2496ED?style=for-the-badge&logo=docker)](https://hub.docker.com/r/synapsr/hovod)
[![GitHub Stars](https://img.shields.io/github/stars/Synapsr/Hovod?style=for-the-badge&logo=github)](https://github.com/Synapsr/Hovod)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

[Quick Start](#quick-start) &bull; [What you get](#what-you-get) &bull; [Deployment](#deployment-modes) &bull; [API](#api-at-a-glance) &bull; [Configuration](#configuration) &bull; [Docker Guide](DOCKER.md)

<br>

https://github.com/user-attachments/assets/bc9d7ec3-d351-405f-874a-a3b8db9f309f

</div>

---

## What is Hovod?

Hovod is an open-source, self-hosted alternative to [Mux](https://mux.com). Upload a video, get adaptive HLS renditions up to 4K/8K, and deliver them from your own infrastructure — with analytics, AI transcription, comments and an embeddable player included.

| | |
|:--|:--|
| **Upload** through the dashboard or the REST API | **Transcode** automatically to adaptive HLS (360p → 4320p) |
| **Stream** with any HLS player or the built-in embeddable one | **Measure** with session-based analytics, retention and referrers |

### Two ways to run it

|  | **Self-hosted** | **Hovod Cloud** |
|--|-----------------|-----------------|
| Price | **Free, forever** | Paid subscription — [see pricing](https://hovod.dev/#pricing) |
| Limits | **None.** No plan, no quota, no metering, no phone-home | Per-plan encoding / AI / storage quotas |
| Infrastructure | Yours: one container + an S3 bucket | Managed: API, workers, database, CDN, backups |
| Code | This repository, MIT licensed | **The same code**, run with `HOVOD_CLOUD=true` |
| Support | GitHub issues & discussions | Email support, SLA on Business |

The cloud is the identical open-source build with billing switched on: nothing here is crippled to sell it, and there is no "open core" edition. See **[docs/self-host-vs-cloud.md](docs/self-host-vs-cloud.md)** for the honest, feature-by-feature comparison — and [docs/cloud.md](docs/cloud.md) if you want to run a paid Hovod service yourself.

---

## Quick Start

One image, everything included (API, worker, dashboard, database, queue). You only need **S3-compatible storage**.

```bash
docker run -d \
  --name hovod \
  --restart unless-stopped \
  --stop-timeout 60 \
  -p 3000:3000 \
  -v hovod-data:/data \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET=my-hovod-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... \
  -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=https://my-hovod-bucket.s3.amazonaws.com \
  -e S3_FORCE_PATH_STYLE=false \
  synapsr/hovod
```

**That's it.** Open `http://localhost:3000`, create the first account, drop in a video.

- **MariaDB and Redis run inside the container** — no external services to wire up.
- **Secrets are generated on first boot** (`JWT_SECRET`, the MariaDB root password) and persisted in `/data/.hovod-secrets`, so the container survives a restart.
- **Everything stateful lives in `/data`** — the database, the upload buffer, the FFmpeg scratch space and the backups. Back up that volume and you have backed up your install.
- Processes are supervised by s6-overlay: a crash restarts within a second, `docker stop` shuts down in order.

> Playback is served **directly from S3**. The API only handles metadata and coordination — your storage (or CDN) absorbs all the bandwidth.

---

## What you get

### Video pipeline

| Feature | Details |
|---------|---------|
| **Adaptive HLS ladder** | 360p, 480p, 720p, 1080p, 1440p, **2160p (4K)** and **4320p (8K)** — H.264 + AAC, capped at the source resolution so nothing is upscaled |
| **Modern encoding** | 6-second segments with aligned keyframes, `EXT-X-INDEPENDENT-SEGMENTS`, real measured `BANDWIDTH` / `RESOLUTION` / `FRAME-RATE` in the master playlist |
| **Difficult sources** | 10-bit / HEVC / ProRes / rotated phone footage; HDR (PQ, HLG) is tone-mapped to SDR BT.709 |
| **Thumbnails** | Poster frame plus a bounded seek-preview sprite with a WebVTT timeline |
| **MP4 download** | One `download.mp4` remuxed from the best rendition, opt-in per video |
| **Hardware-adaptive** | Concurrency, FFmpeg threads and pool sizes derive from the CPU/RAM budget — cgroup v2 limits included |
| **Resilient jobs** | Idempotent transcodes, deterministic job ids, automatic retry with backoff, real FFmpeg stderr in `errorMessage`, a Retry button for anything that got stuck |

### Analytics

Session-based, no third-party tracker, no cookie banner needed.

Views (playback actually started, deduplicated per session, owner previews excluded), unique viewers, watch time, average watched, completion rate, a 10-point retention curve, engagement score, hourly/daily time series, peak hour, devices, quality distribution, buffering ratio, errors and top referrers — every tile answering the same `7d` / `30d` / `90d` / `all` window.

### AI (optional)

Point Hovod at any Whisper-compatible endpoint and any OpenAI-compatible LLM — hosted or **entirely local** (see [100% local & sovereign setup](#100-local--sovereign-setup)):

- **Transcription** with word-level segments (long files are chunked automatically)
- **WebVTT subtitles**, rendered by the player and editable from the dashboard
- **Chapters** generated from the transcript, editable and shown in the player

### Sharing & engagement

| Feature | Details |
|---------|---------|
| **Embeddable player** | `<iframe src=".../embed/:playbackId">` — a standalone bundle, not the dashboard. Quality selector, seek previews, captions, keyboard and touch controls, fullscreen, automatic recovery from network errors |
| **Embed parameters** | `?autoplay=1&muted=1&loop=1&t=90&cc=1&color=%23ff0055&title=…` |
| **Watch page** | A ready-made public page at `/watch/:playbackId` |
| **Comments & reactions** | Timestamped comments and emoji reactions on public pages, toggleable per video |
| **Per-video controls** | Downloads, transcript, chapters and comments each on or off |

### Teams & API

| Feature | Details |
|---------|---------|
| **Accounts & organizations** | Email/password auth, several orgs per user, owner / admin / member roles |
| **Invitations** | Invite by email (7-day token); with no mail provider the invite link is simply handed to the inviter |
| **Password reset** | By email, or from the CLI (`hovod-cli reset-password <email>`) when self-hosting without mail |
| **API keys** | Per-org keys with `read` / `read+write` scopes and optional expiry; revoked automatically when their creator leaves |
| **REST API** | Paginated listing, presigned and multipart uploads, URL import, playback, analytics, webhooks |
| **Branding** | Organization logo, primary colour and theme, applied to the player and the public pages |
| **i18n** | Dashboard in English, French, German and Spanish |

---

## Deployment modes

> **Full Docker guide**: **[DOCKER.md](DOCKER.md)** — every mode, the complete environment table, secrets, backups, upgrades, scaling and troubleshooting. Short version: [docs/deployment.md](docs/deployment.md).

One image — `synapsr/hovod` (also `ghcr.io/synapsr/hovod`, `linux/amd64` + `linux/arm64`) — for every deployment size.

### 1. All-in-one (simplest)

The [Quick Start](#quick-start) above: API, dashboard, worker, MariaDB and Redis in one container. Only S3 is external.

### 2. All-in-one + external database / Redis

Set `DATABASE_URL` and/or `REDIS_URL` and the matching embedded service is not started — use managed MySQL/MariaDB and Redis while keeping a single container.

```bash
docker run -d --name hovod --restart unless-stopped --stop-timeout 60 \
  -p 3000:3000 -v hovod-data:/data \
  -e DATABASE_URL=mysql://user:pass@db-host:3306/hovod \
  -e REDIS_URL=redis://redis-host:6379 \
  -e S3_ENDPOINT=... -e S3_REGION=... -e S3_BUCKET=... \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=... -e S3_FORCE_PATH_STYLE=false \
  synapsr/hovod
```

### 3. Split roles (scale out)

The same image runs as dedicated API and worker containers with `HOVOD_ROLE=api` / `HOVOD_ROLE=worker` against external MySQL, Redis and S3. API replicas are stateless (give them all the same `JWT_SECRET`); workers scale with your encoding backlog.

```bash
cp .env.example .env    # DATABASE_URL, REDIS_URL, JWT_SECRET, S3_*
docker compose -f docker-compose.prod.yml up -d --scale worker=3
```

See [`docker-compose.prod.yml`](docker-compose.prod.yml) and [DOCKER.md → Mode 3](DOCKER.md#mode-3-split-deployment-with-hovod_role).

### 4. Docker Compose (development only)

MySQL, Redis and MinIO as separate containers plus the image built from source. Default credentials, ports bound to `127.0.0.1` — **not for production**.

```bash
git clone https://github.com/Synapsr/Hovod.git && cd Hovod
cp .env.example .env
docker compose up -d --build
```

Dashboard + API: **http://localhost:3002** | MinIO console: http://localhost:9001

### One-click platforms

| Platform | How to deploy |
|----------|---------------|
| **EasyPanel** | Add Docker app → `synapsr/hovod` |
| **Dokploy** | Import from Docker Hub |
| **Coolify** | One-click from Docker image |
| **Portainer** | Create stack from compose |
| **Railway** | Deploy from Docker image |

Mount a persistent volume at `/data`, set the S3 variables, and set `APP_URL` to the public URL. That is all the platform needs to know.

---

## Backups & upgrading

```bash
# Backup (embedded MariaDB → /data/backups, keeps the last 7)
docker exec hovod hovod-backup
docker exec hovod hovod-backup - > hovod.sql.gz        # stream it off the host

# Restore
docker exec -i hovod hovod-restore --yes - < hovod.sql.gz

# Upgrade: back up, pull, recreate with the same command and the same volume
docker exec hovod hovod-backup
docker pull synapsr/hovod
docker stop -t 60 hovod && docker rm hovod
docker run -d --name hovod ... -v hovod-data:/data ... synapsr/hovod
```

Database migrations are versioned SQL files applied automatically at API startup, serialised across replicas with a MySQL advisory lock. An existing install is detected and baselined without re-running anything.

Details: [DOCKER.md → Backups](DOCKER.md#backups) and [→ Upgrading](DOCKER.md#upgrading). Coming from 0.x? Read the [CHANGELOG](CHANGELOG.md#upgrading-from-0x) first.

---

## API at a glance

Full reference: **[docs/api-reference.md](docs/api-reference.md)**.

```bash
# Authenticate once (or use an org API key: -H "X-Api-Key: mk_live_…")
TOKEN=$(curl -s -X POST http://localhost:3000/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"…"}' | jq -r .data.token)

# Create an asset, upload the file, start transcoding
ID=$(curl -s -X POST http://localhost:3000/v1/assets -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"title":"My Video"}' | jq -r .data.id)
URL=$(curl -s -X POST http://localhost:3000/v1/assets/$ID/upload-url \
  -H "Authorization: Bearer $TOKEN" | jq -r .data.uploadUrl)
curl -X PUT "$URL" --data-binary @video.mp4
curl -X POST http://localhost:3000/v1/assets/$ID/process -H "Authorization: Bearer $TOKEN"

# Anyone can now play it — no credentials
curl http://localhost:3000/v1/playback/<playbackId>
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/auth/signup`, `/v1/auth/login` | `POST` | Create an account / sign in — returns a 24 h JWT |
| `/v1/assets` | `POST` | Create an asset (returns `id` + `playbackId`) |
| `/v1/assets` | `GET` | List assets — keyset pagination (`limit`, `cursor`), search (`q`), filters |
| `/v1/assets/:id` | `GET` `PATCH` `DELETE` | Asset with its renditions / update / permanently delete |
| `/v1/assets/:id/upload-url` | `POST` | Pre-signed single-`PUT` upload URL |
| `/v1/assets/:id/multipart/create` · `part-url` · `complete` · `abort` | `POST` | S3 multipart upload for large files (resumable, retried per part) |
| `/v1/assets/:id/import` | `POST` | Import from a public URL (SSRF-guarded) |
| `/v1/assets/:id/process` | `POST` | Start transcoding |
| `/v1/assets/:id/playback` | `GET` | Manifest + player URL (org-scoped) |
| `/v1/assets/:id/analytics` | `GET` | Per-video metrics for `7d` / `30d` / `90d` / `all` |
| `/v1/analytics/overview` | `GET` | Organization-wide metrics and top videos |
| `/v1/playback/:playbackId` | `GET` | **Public** playback metadata (manifest, poster, AI tracks, branding) |
| `/v1/orgs/:orgId/api-keys` | `GET` `POST` | List / create API keys (owner & admin) |
| `/v1/orgs/:orgId/members/invite` | `POST` | Invite a teammate by email |

All successful responses are `{ "data": … }`; list endpoints add `{ "pagination": … }`; errors are `{ "error": "…" }`.

---

## Configuration

Every setting is an environment variable, validated with Zod at startup — a missing or malformed value stops the boot with a precise message. Full table: **[docs/configuration.md](docs/configuration.md)**.

### Required

| Variable | Description |
|----------|-------------|
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_REGION` | S3 region |
| `S3_BUCKET` | Bucket name |
| `S3_ACCESS_KEY_ID` | Access key |
| `S3_SECRET_ACCESS_KEY` | Secret key |
| `S3_PUBLIC_BASE_URL` | Public URL objects are served from (used to build HLS playback URLs) |
| `JWT_SECRET` | Signs access tokens (≥ 32 chars). **Auto-generated and persisted** in the all-in-one image; required explicitly for `HOVOD_ROLE=api` |

<details>
<summary><b>Optional</b></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | embedded MariaDB | MySQL/MariaDB connection string |
| `REDIS_URL` | embedded Redis | Redis connection string (BullMQ) |
| `HOVOD_ROLE` | `allinone` | `allinone`, `api` or `worker` |
| `PORT` | `3000` | API + dashboard port |
| `APP_URL` | `http://localhost:3000` | Public base URL — embed/share links, emails, billing return URLs. `DASHBOARD_URL` is a deprecated alias |
| `CORS_ORIGIN` | `*` | Comma-separated allow-list. `*` logs a warning in production |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style S3 URLs (`false` for AWS S3) |
| `S3_PUBLIC_ENDPOINT` | = `S3_ENDPOINT` | Endpoint used to sign browser-facing upload URLs |
| `S3_PUBLIC_ACL` | `true` | Set `false` for Cloudflare R2 or buckets with ACLs disabled |
| `API_KEY_SECRET` | = `JWT_SECRET` | Separate pepper for API-key hashes so `JWT_SECRET` can rotate |
| `REGISTRATION_ENABLED` | `true` | `false` closes signups |
| `REGISTRATION_ALLOWED_DOMAINS` | — | Comma-separated email domains allowed to sign up |
| `UPLOAD_DIR` | `/data/uploads` | Direct-upload buffer shared by API and worker |
| `WORK_DIR` | `/data/tmp` | FFmpeg scratch space (needs ~3× the source size free) |
| `WORKER_CONCURRENCY` | auto | Concurrent transcode jobs |
| `FFMPEG_THREADS` | auto | Threads per FFmpeg process |
| `DB_POOL_SIZE` | auto | MySQL connection pool size |
| `ANALYTICS_RETENTION_DAYS` | `400` | Playback sessions older than this are purged daily |
| `RESEND_API_KEY`, `EMAIL_FROM` | — | [Resend](https://resend.com) credentials; without them invitations are link-only and password resets come from the CLI |
| `WEBHOOK_URL` | — | Global webhook receiver for asset events |
| `NODE_ENV` | `development` | `development`, `test` or `production` |

```
[worker] Hardware-adaptive config:
  CPU cores:      8
  Total RAM:      16.0 GB
  Concurrency:    2 job(s)
  FFmpeg threads: 4 per job
  DB pool size:   6
```

</details>

<details>
<summary><b>AI processing</b></summary>

Omit these and AI features are simply absent from the UI.

| Variable | Description |
|----------|-------------|
| `WHISPER_API_URL` | Whisper-compatible transcription endpoint (OpenAI, Groq, faster-whisper, …) |
| `WHISPER_API_KEY` | API key for that endpoint |
| `WHISPER_MODEL` | Model name (default `whisper-1`) |
| `LLM_PROVIDER` | Chapter generation provider: `openai`, `anthropic`, `groq` or `custom` |
| `LLM_API_KEY` | API key for the LLM |
| `LLM_MODEL` | Model name (e.g. `gpt-4o-mini`, `llama-3.3-70b-versatile`) |
| `LLM_API_URL` | Custom endpoint (leave empty for the provider default) |
| `AI_ENABLED` | `false` disables AI even when configured |

</details>

<details>
<summary><b>Cloud mode (only if you run a paid service)</b></summary>

**Self-hosters never need any of this.** Leave `HOVOD_CLOUD` unset and Hovod is unlimited and never contacts Stripe. Setting it turns the deployment into a paid-only service — the full operator guide is [docs/cloud.md](docs/cloud.md).

| Variable | Description |
|----------|-------------|
| `HOVOD_CLOUD` | `true` enables paid mode on the API **and** the worker |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the `POST /v1/billing/webhook` endpoint |
| `STRIPE_PRICE_PRO` | Recurring price id of the Pro plan |
| `STRIPE_PRICE_BUSINESS` | Recurring price id of the Business plan |

With `HOVOD_CLOUD=true` these variables plus `RESEND_API_KEY` and `EMAIL_FROM` are validated together: the API refuses to boot half-configured.

</details>

<details>
<summary><b>S3 provider examples</b></summary>

**AWS S3**
```env
S3_ENDPOINT=https://s3.amazonaws.com
S3_REGION=us-east-1
S3_BUCKET=my-hovod-bucket
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://my-hovod-bucket.s3.amazonaws.com
S3_FORCE_PATH_STYLE=false
```

**Cloudflare R2** (zero egress fees — recommended behind a CDN)
```env
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=hovod
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://cdn.example.com
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_ACL=false          # R2 has no per-object ACLs
```

**Backblaze B2**
```env
S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com
S3_REGION=us-west-004
S3_BUCKET=hovod
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://f004.backblazeb2.com/file/hovod
S3_FORCE_PATH_STYLE=true
```

**MinIO (self-hosted)**
```env
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=hovod-vod
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_PUBLIC_BASE_URL=http://localhost:9000/hovod-vod
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_FORCE_PATH_STYLE=true
```

</details>

---

## Tech stack

| Technology | Purpose |
|------------|---------|
| **TypeScript** | Every package, strict mode |
| **Fastify** | REST API with Zod validation, Helmet, rate limiting |
| **FFmpeg** | Transcoding to H.264 HLS |
| **BullMQ + Redis** | Job queue with retries, backoff and stalled-job recovery |
| **MySQL / MariaDB + Drizzle ORM** | State, with versioned SQL migrations |
| **React + Vite + Tailwind CSS v4** | Dashboard SPA, TanStack Query data layer |
| **hls.js** | Embeddable adaptive player (standalone bundle) |
| **S3-compatible storage** | Sources, HLS output and delivery |

### Project structure

```
hovod/
├── apps/
│   ├── api/                  # Fastify REST API (also serves the built dashboard)
│   ├── worker/               # FFmpeg transcode + AI worker
│   └── dashboard/            # React SPA + standalone /embed bundle
├── packages/
│   └── db/                   # Drizzle schemas, constants, migrations + runner
│       └── migrations/       # 0001_baseline.sql, 0002_…, applied at boot
├── docker/                   # s6-overlay service definitions and boot hook
├── scripts/                  # hovod-backup / hovod-restore / doc checks
├── docs/                     # API reference, configuration, deployment, cloud
├── Dockerfile                # The single image (HOVOD_ROLE=allinone|api|worker)
├── docker-compose.yml        # Development stack
└── docker-compose.prod.yml   # Split deployment example
```

---

## Development setup

```bash
git clone https://github.com/Synapsr/Hovod.git && cd Hovod
npm install
cp .env.example .env

# Infrastructure only (MySQL, Redis, MinIO)
docker compose up -d mysql redis minio minio-init

npm run build -w @hovod/db        # shared package first — api and worker depend on it
npm run dev -w @hovod/api         # API on :3000
npm run dev -w @hovod/worker      # Worker
npm run dev -w @hovod/dashboard   # Dashboard on :3001
```

<details>
<summary><b>Available scripts</b></summary>

```bash
npm run build                     # Build all workspaces (correct order)
npm run typecheck                 # Typecheck all workspaces
npm run lint                      # Lint all workspaces
npm test -w @hovod/db             # Migration, URL-guard and quota tests (Docker-backed)
npm test -w @hovod/api            # Pagination, entitlements, analytics, billing
node scripts/check-env-docs.mjs   # Every env var in env.ts is documented
```

</details>

Requirements: Node.js ≥ 20 and FFmpeg (for the worker). More in [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).

---

## 100% local & sovereign setup

Hovod can run **entirely on your infrastructure** with zero external API calls. Transcoding, transcription and chapter generation all happen locally — no data leaves your network.

> Suited to enterprises, government, healthcare, defence, and anyone who takes data sovereignty seriously.

<details>
<summary><b>Full sovereign stack with Docker Compose</b></summary>

```yaml
# docker-compose.sovereign.yml
services:

  # ── Video platform (API + worker + dashboard + DB + Redis) ──
  hovod:
    image: synapsr/hovod
    ports:
      - "3000:3000"
    volumes:
      - hovod-data:/data
    environment:
      # S3 → local MinIO
      - S3_ENDPOINT=http://minio:9000
      - S3_REGION=us-east-1
      - S3_BUCKET=hovod-vod
      - S3_ACCESS_KEY_ID=minioadmin
      - S3_SECRET_ACCESS_KEY=minioadmin
      - S3_PUBLIC_BASE_URL=http://localhost:9000/hovod-vod
      - S3_PUBLIC_ENDPOINT=http://localhost:9000
      - S3_FORCE_PATH_STYLE=true
      # AI → local Whisper + Ollama
      - WHISPER_API_URL=http://whisper:8000/v1/audio/transcriptions
      - WHISPER_API_KEY=sk-local
      - WHISPER_MODEL=Systran/faster-distil-whisper-large-v3
      - LLM_PROVIDER=custom
      - LLM_API_KEY=ollama
      - LLM_MODEL=llama3.1
      - LLM_API_URL=http://ollama:11434/v1
    depends_on:
      minio-init:
        condition: service_completed_successfully
      whisper:
        condition: service_started
      ollama:
        condition: service_started
    restart: unless-stopped

  # ── S3 storage (MinIO) ─────────────────────────────────────
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"    # MinIO console
    volumes:
      - minio-data:/data
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    restart: unless-stopped

  minio-init:
    image: minio/mc
    entrypoint: >
      sh -c "
        mc alias set local http://minio:9000 minioadmin minioadmin &&
        mc mb --ignore-existing local/hovod-vod &&
        mc anonymous set download local/hovod-vod
      "
    depends_on:
      minio:
        condition: service_started

  # ── Local Whisper (speech-to-text) ─────────────────────────
  whisper:
    image: fedirz/faster-whisper-server:latest-cpu
    # For GPU: image: fedirz/faster-whisper-server:latest-cuda
    ports:
      - "8000:8000"
    volumes:
      - whisper-models:/root/.cache/huggingface
    # Uncomment for NVIDIA GPU acceleration:
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]
    restart: unless-stopped

  # ── Local LLM (chapter generation) ─────────────────────────
  ollama:
    image: ollama/ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama-models:/root/.ollama
    restart: unless-stopped

  # Pull the LLM model on first run
  ollama-init:
    image: ollama/ollama
    entrypoint: >
      sh -c "
        sleep 5 &&
        ollama pull llama3.1
      "
    environment:
      - OLLAMA_HOST=http://ollama:11434
    depends_on:
      ollama:
        condition: service_started

volumes:
  hovod-data:
  minio-data:
  whisper-models:
  ollama-models:
```

```bash
docker compose -f docker-compose.sovereign.yml up -d
```

Open **http://localhost:3000** — upload a video and watch it get transcoded, transcribed, subtitled and chaptered without a single byte leaving your network.

**GPU acceleration**: install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html), switch the whisper image to `fedirz/faster-whisper-server:latest-cuda` and uncomment the `deploy.resources` block.

| Hardware | Transcription speed | 1 h video |
|----------|--------------------|-----------|
| CPU only (8 cores) | ~1× realtime | ~60 min |
| RTX 3060 | ~15× realtime | ~4 min |
| RTX 4090 | ~40× realtime | ~1.5 min |

**Model choices**: `Systran/faster-whisper-tiny` (75 MB, fast) → `Systran/faster-distil-whisper-large-v3` (1.5 GB, the sweet spot) → `Systran/faster-whisper-large-v3` (3 GB, best). For chapters: `llama3.1` (8 GB RAM), `mistral` (7 GB), `phi3` (4 GB), `gemma2` (5 GB).

</details>

---

## Roadmap

v1.0 ships what is in this README and nothing more — the list below is what we intend to build next, not what you are buying today.

| | Planned for |
|---|---|
| **Private videos** — playback restricted to signed-in viewers | v1.1 |
| **Signed playback URLs** — expiring, per-viewer tokens | v1.1 |
| **Custom player domain** — serve embeds from your own hostname | v1.1 |
| **Webhook retries** — durable delivery with backoff and a delivery log | v1.1 |
| **Yearly billing** (cloud) — two months free | v1.1 |
| **AV1 rendition** (SVT-AV1) as an optional top rung | later |

Playback ids are 16 random characters, so a video is unlisted-by-default today, but it is not access-controlled. Want to shape what comes next? [Open a discussion](https://github.com/Synapsr/Hovod/discussions).

---

## Contributing

Contributions are welcome — see **[CONTRIBUTING.md](CONTRIBUTING.md)** for the workflow, the coding conventions and how to add a database migration.

- **Report bugs** — [open an issue](https://github.com/Synapsr/Hovod/issues)
- **Suggest features** — start a [discussion](https://github.com/Synapsr/Hovod/discussions)
- **Improve docs** — the `docs/` folder is as reviewable as the code

```bash
git clone https://github.com/YOUR_USERNAME/Hovod.git
git checkout -b feature/amazing-feature
npm run typecheck && npm run lint      # CI runs these plus a docker smoke test
git commit -m 'feat: amazing feature'
git push origin feature/amazing-feature
```

Security issues: please follow [SECURITY.md](SECURITY.md) rather than opening a public issue.

---

## License

[MIT](LICENSE) — free for personal and commercial use, self-hosted without limits.

---

<div align="center">

**If Hovod is useful to you, consider giving it a star!**

[![Star on GitHub](https://img.shields.io/github/stars/Synapsr/Hovod?style=social)](https://github.com/Synapsr/Hovod)

---

Built with FFmpeg, Fastify, and open-source spirit by [Synapsr](https://github.com/synapsr)

[Report Bug](https://github.com/Synapsr/Hovod/issues) &bull; [Request Feature](https://github.com/Synapsr/Hovod/discussions) &bull; [Docker Guide](DOCKER.md) &bull; [Hovod Cloud](https://hovod.dev/#pricing)

</div>
