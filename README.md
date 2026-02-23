<div align="center">

# Hovod

### The Open-Source Video Platform

**Stop paying per-minute for video infrastructure. Own your video pipeline.**

[![Docker](https://img.shields.io/badge/Docker-synapsr%2Fhovod-2496ED?style=for-the-badge&logo=docker)](https://hub.docker.com/r/synapsr/hovod)
[![GitHub Stars](https://img.shields.io/github/stars/Synapsr/Hovod?style=for-the-badge&logo=github)](https://github.com/Synapsr/Hovod)
[![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

[Quick Start](#-quick-start) &bull; [Features](#-features) &bull; [API](#-api-at-a-glance) &bull; [Configuration](#-configuration) &bull; [Docker Guide](DOCKER.md)

</div>

---

## What is Hovod?

Hovod is an open-source, self-hosted alternative to [Mux](https://mux.com). Upload a video, get adaptive HLS streams in 360p/720p/1080p, and deliver them from your own infrastructure. No vendor lock-in, no per-minute pricing.

| | |
|:--|:--|
| **Upload** a video through the dashboard or REST API | **Transcode** automatically to adaptive HLS (360p, 720p, 1080p) |
| **Stream** via any HLS player or the built-in embeddable player | **Scale** with hardware-adaptive workers that auto-tune to your machine |

---

## Why Hovod?

| **No Per-Minute Fees** | **One Command Deploy** | **Own Your Data** |
|:----------------------:|:----------------------:|:-----------------:|
| Self-host for free. No usage-based billing, no vendor lock-in. | Single Docker image with embedded database & queue. Just add S3. | Your server, your storage, your videos. Full control. |

| **AI-Powered** | **S3-Compatible** | **Embeddable Player** |
|:--------------:|:-----------------:|:---------------------:|
| Optional transcription, subtitles & chapter generation via Whisper + LLM. | Works with AWS S3, Cloudflare R2, Backblaze B2, MinIO, and more. | Drop-in HLS player with quality selector and thumbnail seek preview. |

---

## How It Works

```
 Upload/Import          Transcode             Deliver
+-----------+      +--------------+      +------------+
|  Video in  |----->|  FFmpeg HLS  |----->|  S3 / CDN  |
|  (API)     |      |  (Worker)    |      |  (Stream)  |
+-----------+      +--------------+      +------------+
     |                                         |
     v                                         v
  Dashboard                              HLS Player
```

1. **Upload** a video through the dashboard or API
2. **Transcode** automatically to adaptive HLS (360p, 720p, 1080p)
3. **Stream** via any HLS player, or use the built-in embeddable player

> Video playback is served **directly from S3**. The API only handles metadata and coordination — S3 absorbs all bandwidth, keeping the API lightweight.

---

## Quick Start

One image, everything included (API, worker, dashboard, database, queue). You only need **S3-compatible storage**.

```bash
docker run -d \
  --name hovod \
  -p 3000:3000 \
  -v hovod-data:/data \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET=my-hovod-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... \
  -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=https://my-hovod-bucket.s3.amazonaws.com \
  synapsr/hovod
```

**That's it.** Open `http://localhost:3000` — dashboard and API on the same port.

> MariaDB and Redis run inside the container automatically. Data is persisted in the `/data` volume.

---

## Features

### Dashboard & Player

| | Feature | Description |
|:-:|---------|-------------|
| | **Dashboard** | Web UI to upload, manage, and preview all your video assets |
| | **Embeddable Player** | HLS player with adaptive quality selector and thumbnail seek preview |
| | **Direct Upload** | Pre-signed S3 URLs for efficient browser-to-storage uploads |
| | **URL Import** | Import videos from any public URL |
| | **Transcript & Subtitles** | AI-generated transcription and WebVTT subtitles (via Whisper API) |
| | **Chapters** | Auto-generated chapters from transcript (via LLM) |

### Video Pipeline

| | Feature | Description |
|:-:|---------|-------------|
| | **Adaptive Bitrate** | HLS output in 360p / 720p / 1080p (H.264 + AAC) |
| | **Thumbnail Sprites** | Seek preview thumbnails with VTT metadata |
| | **Hardware-Adaptive** | Workers auto-detect CPU/RAM to optimize concurrency and threading |
| | **Horizontal Scaling** | Run multiple stateless workers against the same Redis queue |
| | **REST API** | Clean JSON endpoints for full programmatic control |
| | **S3-Compatible** | AWS S3, Cloudflare R2, Backblaze B2, MinIO — anything S3-compatible |

---

## Deployment

> **Full Docker guide**: See **[DOCKER.md](DOCKER.md)** for architecture diagrams, all deployment modes, scaling, and networking reference.

### All-in-One (simplest)

Everything in a single container. Database and Redis are embedded. Only S3 storage is external.

```bash
docker run -d \
  --name hovod \
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

### External Database & Redis (production)

For production, use external MySQL/MariaDB and Redis. Set `DATABASE_URL` and/or `REDIS_URL` to disable the embedded services.

```bash
docker run -d \
  --name hovod \
  -p 3000:3000 \
  -e DATABASE_URL=mysql://user:pass@db-host:3306/hovod \
  -e REDIS_URL=redis://redis-host:6379 \
  -e S3_ENDPOINT=https://s3.amazonaws.com \
  -e S3_REGION=us-east-1 \
  -e S3_BUCKET=my-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... \
  -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=https://my-bucket.s3.amazonaws.com \
  -e S3_FORCE_PATH_STYLE=false \
  synapsr/hovod
```

### Docker Compose (development)

```bash
git clone https://github.com/Synapsr/Hovod.git && cd Hovod
cp .env.example .env
docker compose up -d --build
```

Dashboard: **http://localhost:3003** | API: **http://localhost:3002**

### One-Click Deploy

Works out of the box with your favorite platforms:

| Platform | How to deploy |
|----------|---------------|
| **EasyPanel** | Add Docker app → `synapsr/hovod` |
| **Dokploy** | Import from Docker Hub |
| **Coolify** | One-click from Docker image |
| **Portainer** | Create stack from compose |
| **Railway** | Deploy from Docker image |

---

## API at a Glance

```bash
# Create an asset
curl -X POST http://localhost:3000/v1/assets \
  -H "Content-Type: application/json" \
  -d '{"title": "My Video"}'

# Get upload URL, upload file, start transcoding
curl -X POST http://localhost:3000/v1/assets/{id}/upload-url
curl -X PUT "<uploadUrl>" --data-binary @video.mp4
curl -X POST http://localhost:3000/v1/assets/{id}/process

# Get playback URL
curl http://localhost:3000/v1/assets/{id}/playback
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/assets` | `POST` | Create a new asset |
| `/v1/assets` | `GET` | List all assets |
| `/v1/assets/:id` | `GET` | Get asset details + renditions |
| `/v1/assets/:id/upload-url` | `POST` | Get pre-signed upload URL |
| `/v1/assets/:id/import` | `POST` | Import from external URL |
| `/v1/assets/:id/process` | `POST` | Start transcoding |
| `/v1/assets/:id/playback` | `GET` | Get HLS manifest + player URL |
| `/v1/assets/:id` | `DELETE` | Soft-delete an asset |
| `/v1/playback/:playbackId` | `GET` | Public playback endpoint |

---

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_REGION` | S3 region |
| `S3_BUCKET` | S3 bucket name |
| `S3_ACCESS_KEY_ID` | S3 access key |
| `S3_SECRET_ACCESS_KEY` | S3 secret key |
| `S3_PUBLIC_BASE_URL` | Public URL to access S3 objects (used for HLS playback URLs) |

<details>
<summary><b>Optional variables</b></summary>

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | embedded MariaDB | MySQL/MariaDB connection string |
| `REDIS_URL` | embedded Redis | Redis connection string |
| `PORT` | `3000` | API/dashboard port |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style S3 URLs (set `false` for AWS S3) |
| `S3_PUBLIC_ENDPOINT` | same as `S3_ENDPOINT` | Public S3 endpoint for browser uploads |
| `CORS_ORIGIN` | `*` | Allowed CORS origins (comma-separated) |
| `DASHBOARD_URL` | `http://localhost:3000` | Base URL for embed player URLs |
| `JWT_SECRET` | — | Secret for JWT auth (required in split mode) |

</details>

<details>
<summary><b>Registration control</b></summary>

Control who can create accounts on your Hovod instance. By default, registration is open to everyone.

| Variable | Default | Description |
|----------|---------|-------------|
| `REGISTRATION_ENABLED` | `true` | Set to `false` to disable new account registration |
| `REGISTRATION_ALLOWED_DOMAINS` | — | Comma-separated list of allowed email domains (e.g. `company.com,partner.org`) |

```env
# Disable all new registrations
REGISTRATION_ENABLED=false

# Allow only specific email domains
REGISTRATION_ALLOWED_DOMAINS=company.com,partner.org

# Both can be combined: enabled but restricted to certain domains
REGISTRATION_ENABLED=true
REGISTRATION_ALLOWED_DOMAINS=company.com
```

</details>

<details>
<summary><b>AI Processing (optional)</b></summary>

Hovod can auto-generate transcripts, subtitles, and chapters. Omit these variables to disable AI features.

| Variable | Description |
|----------|-------------|
| `WHISPER_API_URL` | Whisper-compatible transcription endpoint (OpenAI, Groq, local) |
| `WHISPER_API_KEY` | API key for Whisper service |
| `WHISPER_MODEL` | Model name (e.g. `whisper-1`) |
| `LLM_PROVIDER` | Chapter generation provider (`openai`, `anthropic`, `groq`, `custom`) |
| `LLM_API_KEY` | API key for LLM service |
| `LLM_MODEL` | Model name (e.g. `gpt-4o-mini`, `llama-3.3-70b-versatile`) |
| `AI_ENABLED` | Set to `false` to disable AI even if configured |

</details>

<details>
<summary><b>Scaling (auto-detected)</b></summary>

The worker auto-detects CPU cores and available RAM at startup. No manual tuning needed.

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CONCURRENCY` | auto | Concurrent transcode jobs |
| `FFMPEG_THREADS` | auto | Threads per FFmpeg process |
| `DB_POOL_SIZE` | auto | MySQL connection pool size |

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
<summary><b>S3 Provider Examples</b></summary>

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

**Cloudflare R2**
```env
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=hovod
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://pub-<hash>.r2.dev
S3_FORCE_PATH_STYLE=true
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

## Tech Stack

| | Technology | Purpose |
|:-:|------------|---------|
| | **TypeScript** | Type-safe development across all packages |
| | **Fastify** | High-performance REST API with Zod validation |
| | **FFmpeg** | Video transcoding (H.264 HLS) |
| | **BullMQ** | Reliable job queue for transcode pipelines |
| | **React + Vite** | Dashboard SPA with Tailwind CSS |
| | **hls.js** | Embeddable adaptive HLS player |
| | **Drizzle ORM** | Type-safe database queries |
| | **MySQL / MariaDB** | Relational database for state |
| | **Redis** | Job queue backend |
| | **S3** | Video storage and HLS delivery |

---

## Project Structure

```
hovod/
+-- apps/
|   +-- api/           # Fastify REST API
|   +-- worker/        # FFmpeg transcode worker
|   +-- dashboard/     # React SPA
+-- packages/
|   +-- db/            # Shared Drizzle schemas & constants
+-- Dockerfile         # All-in-one image
+-- docker-compose.yml # Dev environment (multi-container)
+-- entrypoint.sh      # Standalone entrypoint
+-- .env.example
```

---

## Development Setup

```bash
# Clone the repo
git clone https://github.com/Synapsr/Hovod.git
cd Hovod

# Install dependencies
npm install

# Configure environment
cp .env.example .env

# Build the shared DB package first
npm run build -w @hovod/db

# Start services (requires local MySQL, Redis, S3)
npm run dev -w @hovod/api
npm run dev -w @hovod/worker
npm run dev -w @hovod/dashboard
```

<details>
<summary><b>Available scripts</b></summary>

```bash
npm run build                      # Build all workspaces (correct order)
npm run typecheck                  # Typecheck all workspaces
npm run dev -w @hovod/api          # API dev server (port 3000)
npm run dev -w @hovod/worker       # Worker dev mode
npm run dev -w @hovod/dashboard    # Dashboard dev server (port 3001)
npm run build -w @hovod/db         # Build DB package (must run first)
```

</details>

---

## 100% Local & Sovereign Setup

Hovod can run **entirely on your infrastructure** with zero external API calls. No data leaves your servers — ever. Video transcoding, AI transcription, and chapter generation all happen locally.

> Perfect for enterprises, government, healthcare, defense, and anyone who takes data sovereignty seriously.

| **Zero Cloud Dependencies** | **Air-Gap Ready** | **GPU-Accelerated** |
|:----------------------------:|:------------------:|:-------------------:|
| No OpenAI, no third-party APIs. Everything runs on your hardware. | Works completely offline. No internet required after setup. | Leverage your GPUs for fast transcription with faster-whisper. |

### Full sovereign stack with Docker Compose

This runs the complete pipeline locally: video platform + S3 storage + AI transcription + LLM chapter generation.

```yaml
# docker-compose.sovereign.yml
services:

  # ── Video Platform (API + Worker + Dashboard + DB + Redis) ──
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

  # ── S3 Storage (MinIO) ─────────────────────────────────────
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
    # Uncomment for NVIDIA GPU acceleration:
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]
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

Start everything:

```bash
docker compose -f docker-compose.sovereign.yml up -d
```

Open **http://localhost:3000** — upload a video, and watch it get transcoded, transcribed, subtitled, and chaptered without a single byte leaving your network.

<details>
<summary><b>GPU acceleration</b></summary>

For significantly faster transcription, use your NVIDIA GPU:

1. Install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
2. In the compose file above, switch the whisper image to `fedirz/faster-whisper-server:latest-cuda`
3. Uncomment the `deploy.resources` blocks on the `whisper` and/or `ollama` services
4. Restart: `docker compose -f docker-compose.sovereign.yml up -d`

Transcription speed with GPU (faster-whisper, large-v3):

| Hardware | Speed | 1h video transcribed in |
|----------|-------|------------------------|
| CPU only (8 cores) | ~1x realtime | ~60 min |
| RTX 3060 | ~15x realtime | ~4 min |
| RTX 4090 | ~40x realtime | ~1.5 min |

</details>

<details>
<summary><b>Alternative models</b></summary>

**Whisper models** (trade speed vs. accuracy):

| Model | Size | Quality | Speed |
|-------|------|---------|-------|
| `Systran/faster-whisper-tiny` | 75 MB | Basic | Very fast |
| `Systran/faster-whisper-medium` | 1.5 GB | Good | Moderate |
| `Systran/faster-distil-whisper-large-v3` | 1.5 GB | Excellent | Fast |
| `Systran/faster-whisper-large-v3` | 3 GB | Best | Slower |

**Ollama models** for chapter generation:

| Model | RAM needed | Quality |
|-------|-----------|---------|
| `llama3.1` | 8 GB | Best |
| `mistral` | 7 GB | Great |
| `phi3` | 4 GB | Good, lightweight |
| `gemma2` | 5 GB | Good |

Change models by updating `WHISPER_MODEL` and `LLM_MODEL` in the compose file.

</details>

---

## Contributing

Contributions are welcome! Here's how you can help:

- **Report bugs** — Found an issue? [Open one here](https://github.com/Synapsr/Hovod/issues)
- **Suggest features** — Have an idea? Start a [discussion](https://github.com/Synapsr/Hovod/discussions)
- **Submit PRs** — Code contributions welcome
- **Improve docs** — Help others get started

```bash
# Fork & clone
git clone https://github.com/YOUR_USERNAME/Hovod.git

# Create branch
git checkout -b feature/amazing-feature

# Make changes & commit
git commit -m 'Add amazing feature'

# Push & open PR
git push origin feature/amazing-feature
```

---

## License

[MIT](LICENSE) — free for personal and commercial use.

---

<div align="center">

**If Hovod is useful to you, consider giving it a star!**

[![Star on GitHub](https://img.shields.io/github/stars/Synapsr/Hovod?style=social)](https://github.com/Synapsr/Hovod)

---

Built with FFmpeg, Fastify, and open-source spirit by [Synapsr](https://github.com/synapsr)

[Report Bug](https://github.com/Synapsr/Hovod/issues) &bull; [Request Feature](https://github.com/Synapsr/Hovod/discussions) &bull; [Docker Guide](DOCKER.md)

</div>
