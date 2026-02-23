# Architecture

Hovod is a monorepo with four packages that work together to provide a complete video-on-demand pipeline.

## System Overview

```
┌──────────────┐         ┌─────────────────────────────────────────────┐
│              │         │              Docker Compose                 │
│   Browser /  │  HTTP   │  ┌─────────┐    ┌───────┐    ┌──────────┐  │
│   Client     ├────────►│  │   API   ├───►│ MySQL │    │  MinIO   │  │
│              │         │  │ :3000   │    │ :3306 │    │  (S3)    │  │
└──────────────┘         │  └────┬────┘    └───────┘    │  :9000   │  │
                         │       │                      └────▲─────┘  │
┌──────────────┐         │       │ BullMQ                    │        │
│              │  HTTP   │       ▼                           │        │
│  Dashboard   ├────────►│  ┌─────────┐    ┌───────┐        │        │
│  :3001       │         │  │  Redis  │◄───┤Worker ├────────┘        │
│              │         │  │  :6379  │    │(FFmpeg)│                 │
└──────────────┘         │  └─────────┘    └────────┘                 │
                         └─────────────────────────────────────────────┘
```

## Packages

### `apps/api` — REST API

**Stack:** Fastify + TypeScript

The API server is the central entry point. It handles all asset management, generates signed upload URLs, enqueues transcode jobs, and serves playback information.

- All routes are defined in a single `src/index.ts`
- Runs `CREATE TABLE IF NOT EXISTS` migrations on startup
- Environment variables validated with Zod at startup
- Enqueues transcode jobs to BullMQ via Redis

### `apps/worker` — Transcode Worker

**Stack:** BullMQ + FFmpeg + TypeScript

The worker consumes jobs from the Redis queue and processes videos using FFmpeg.

- Downloads source video from S3 or external URL
- Runs FFmpeg for each rendition (360p, 720p, 1080p)
- Generates HLS segments (6s, H.264/AAC) and master playlist
- Uploads output to S3 under `playback/{assetId}/`
- Updates asset and job status in MySQL

### `apps/dashboard` — Web Dashboard

**Stack:** React + Vite + Tailwind CSS

A single-page application for managing assets and previewing playback.

- Upload videos via signed URLs with progress tracking
- Import videos from external URLs
- Monitor transcoding status (polls every 5s)
- Embeddable HLS player at `/embed/:playbackId` using hls.js

### `packages/db` — Shared Database Layer

**Stack:** Drizzle ORM + mysql2

Shared database schemas and connection factory used by both the API and the worker.

- Exports `createDb()` connection factory
- Defines three tables: `assets`, `renditions`, `jobs`
- Column names use `snake_case` in MySQL, `camelCase` in TypeScript

## Database Schema

### `assets`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `VARCHAR(36)` | Primary key, nanoid(12) |
| `status` | `VARCHAR(32)` | Lifecycle state |
| `source_type` | `VARCHAR(32)` | `upload` or `url` |
| `source_key` | `VARCHAR(512)` | S3 path for uploads |
| `source_url` | `VARCHAR(2048)` | URL for imports |
| `title` | `VARCHAR(255)` | Display name |
| `playback_id` | `VARCHAR(64)` | Unique playback ID, nanoid(16) |
| `metadata` | `JSON` | Optional metadata |
| `duration_sec` | `INT` | Duration in seconds |
| `error_message` | `VARCHAR(1024)` | Error details |
| `created_at` | `TIMESTAMP` | Creation timestamp |
| `updated_at` | `TIMESTAMP` | Last update timestamp |

### `renditions`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `VARCHAR(36)` | Primary key, UUID |
| `asset_id` | `VARCHAR(36)` | Foreign key to assets |
| `quality` | `VARCHAR(32)` | `360p`, `720p`, or `1080p` |
| `width` | `INT` | Resolution width |
| `height` | `INT` | Resolution height |
| `bitrate_kbps` | `INT` | Video bitrate |
| `codec` | `VARCHAR(32)` | Codec (`h264`) |
| `playlist_path` | `VARCHAR(1024)` | S3 path to HLS playlist |
| `created_at` | `TIMESTAMP` | Creation timestamp |

### `jobs`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `VARCHAR(36)` | Primary key, nanoid(12) |
| `asset_id` | `VARCHAR(36)` | Foreign key to assets |
| `type` | `VARCHAR(32)` | Job type (`transcode`) |
| `status` | `VARCHAR(32)` | `queued`, `processing`, `completed`, `failed` |
| `attempts` | `INT` | Retry count |
| `error_message` | `VARCHAR(1024)` | Error details |
| `created_at` | `TIMESTAMP` | Creation timestamp |
| `updated_at` | `TIMESTAMP` | Last update timestamp |

## Transcoding Pipeline

The worker runs FFmpeg to produce a 3-tier adaptive bitrate ladder:

| Quality | Resolution | Video Bitrate | Audio | Codec |
|---------|-----------|---------------|-------|-------|
| 360p | 640 x 360 | 800 kbps | AAC 128k | H.264 |
| 720p | 1280 x 720 | 3,000 kbps | AAC 128k | H.264 |
| 1080p | 1920 x 1080 | 6,000 kbps | AAC 128k | H.264 |

- **Segment duration:** 6 seconds
- **Playlist type:** VOD (not live)
- **Scaling:** `force_original_aspect_ratio=decrease` preserves source aspect ratio

## S3 Storage Layout

```
hovod-vod/
├── sources/
│   └── {assetId}/
│       └── input.mp4              ← original upload
└── playback/
    └── {assetId}/
        ├── master.m3u8            ← HLS master playlist
        ├── 360p/
        │   ├── index.m3u8
        │   └── segment_000.ts ...
        ├── 720p/
        │   ├── index.m3u8
        │   └── segment_000.ts ...
        └── 1080p/
            ├── index.m3u8
            └── segment_000.ts ...
```

- **`sources/`** — Private. Only accessible via pre-signed URLs.
- **`playback/`** — Public read. Anonymous download is enabled for HLS delivery.

## ID Conventions

| Entity | Generator | Length |
|--------|-----------|--------|
| Asset ID | `nanoid(12)` | 12 characters |
| Playback ID | `nanoid(16)` | 16 characters |
| Job ID | `nanoid(12)` | 12 characters |
| Rendition ID | `crypto.randomUUID()` | UUID v4 |
