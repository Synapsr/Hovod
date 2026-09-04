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
- Applies pending SQL migrations from `packages/db/migrations` on startup (see [Database Migrations](#database-migrations))
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
- Defines the Drizzle table schemas (`assets`, `renditions`, `jobs`, analytics, AI, auth, settings, comments, reactions)
- Ships the SQL migrations in `migrations/` and the `runMigrations()` runner
- Column names use `snake_case` in MySQL, `camelCase` in TypeScript

## Database Migrations

The schema is managed by plain SQL files, applied by the API at boot — no
`drizzle-kit`, no external CLI.

```
packages/db/
├── migrations/
│   ├── 0001_baseline.sql        ← full schema as of v0.2.0
│   └── 0002_<name>.sql          ← every later change, one file each
└── src/migrations.ts            ← runMigrations(), legacyRepair(), MIGRATIONS_DIR
```

**File format.** `NNNN_snake_case_name.sql` — a 4-digit zero-padded sequence
number, applied in lexical order. Statements inside a file are separated by a
line containing exactly `-- >statement-breakpoint` (one statement per chunk,
`--` line comments are allowed). File names are validated at boot: a malformed
name or a duplicate sequence number aborts the start.

**Bookkeeping.** Applied files are recorded in `schema_migrations`
(`name VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP`). A file is applied only
if its name is not in that table.

**Boot sequence** (`apps/api/src/index.ts` → `apps/api/src/db.ts` → `@hovod/db`):

1. `SELECT GET_LOCK('hovod_migrations', 120)` on a dedicated pool connection —
   several API replicas can start at once, only one runs the migrations, the
   others wait for the lock and then find nothing to do.
2. Create `schema_migrations` if missing.
3. Apply every pending file, statement by statement. The first failing
   statement throws a `MigrationError` carrying the file name, the statement
   index and the MySQL error; the API logs it and exits with code 1. The failed
   file is **not** recorded, so the next boot retries it — MySQL DDL is not
   transactional, so write migrations so that a partial re-run is harmless.
4. Release the lock.
5. `bootstrapDefaultOrg()` (an explicit data step in `apps/api/src/db.ts`)
   creates the default organization / admin user for upgraded self-hosted
   installs and applies `NOT NULL` to `assets.org_id`.

**Upgrading from a pre-migration install.** Before v1 the API ran
`CREATE TABLE IF NOT EXISTS` plus a list of `ALTER TABLE`s whose errors were
swallowed on every boot. When the runner finds an `assets` table but no
`schema_migrations`, it runs `legacyRepair()` once: it creates any baseline
table that is missing, adds the columns older versions lacked (checked through
`INFORMATION_SCHEMA`, never blind), widens `assets.description` to `TEXT` and
`renditions.file_size_bytes` to `BIGINT`, then records `0001_baseline.sql` as
applied **without executing it**. Migrations `0002+` then run normally. Fresh
databases simply execute the baseline.

**Runtime paths.** `MIGRATIONS_DIR` is resolved from `import.meta.url` of the
`@hovod/db` module, so it works both with `tsx` from `src/` and from `dist/`.
Docker images copy `packages/db/migrations` next to `packages/db/dist`.

**Tests.** `npm test -w @hovod/db` runs `packages/db/scripts/test-migrations.mjs`:
static checks (naming, ordering, parsing, baseline ↔ `schema.ts` coverage) and,
when Docker is available, a throwaway `mysql:8.4` container exercising fresh
install, second no-op boot, legacy repair, failing migration and concurrent boots.

## Database Schema

### `assets`

| Column | Type | Description |
|--------|------|-------------|
| `id` | `VARCHAR(36)` | Primary key, nanoid(12) |
| `org_id` | `VARCHAR(36)` | Owning organization |
| `status` | `VARCHAR(32)` | Lifecycle state |
| `source_type` | `VARCHAR(32)` | `upload` or `url` |
| `source_key` | `VARCHAR(512)` | S3 path for uploads |
| `source_url` | `VARCHAR(2048)` | URL for imports |
| `title` | `VARCHAR(255)` | Display name |
| `playback_id` | `VARCHAR(64)` | Unique playback ID, nanoid(16) |
| `metadata` | `JSON` | Probe metadata |
| `description` | `TEXT` | Rich-text description |
| `public_settings` | `JSON` | Public page configuration |
| `custom_thumbnail_key` | `VARCHAR(512)` | S3 key of a user-provided poster |
| `custom_metadata` | `JSON` | User-defined key/value pairs |
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
| `file_size_bytes` | `BIGINT` | Size of the rendition on S3 |
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
| `current_step` | `VARCHAR(64)` | Granular processing step (`PROCESSING_STEP`) |
| `attempts` | `INT` | Retry count |
| `error_message` | `VARCHAR(1024)` | Error details |
| `created_at` | `TIMESTAMP` | Creation timestamp |
| `updated_at` | `TIMESTAMP` | Last update timestamp |

The remaining tables (`analytics_events`, `analytics_daily`, `analytics_asset_stats`,
`ai_jobs`, `users`, `organizations`, `org_members`, `api_keys`, `settings`,
`comments`, `reactions`) are documented by their DDL in
`packages/db/migrations/0001_baseline.sql` and their Drizzle definitions in
`packages/db/src/schema.ts`.

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
