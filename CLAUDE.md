# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hovod is an open-source video platform (upload → transcode to adaptive HLS → deliver from S3) with a dashboard, an embeddable player, session-based analytics, optional AI transcription/subtitles/chapters, comments, organizations and API keys.

It runs in two modes from the **same code and the same image**:

- **Self-host** (default) — unlimited, no plans, no Stripe, no phone-home.
- **Cloud** (`HOVOD_CLOUD=true`) — paid-only: Stripe Checkout at signup, per-plan quotas, entitlement checks. This is how `hovod.dev` runs. See `docs/cloud.md`.

## Commands

### Docker

```bash
cp .env.example .env
docker compose up -d --build        # dev stack: MySQL + Redis + MinIO + api + worker (dashboard on :3002)
docker compose -f docker-compose.prod.yml up -d   # split deployment example (HOVOD_ROLE=api / worker)
```

### Workspaces

```bash
npm run build                  # build all workspaces in dependency order
npm run typecheck              # typecheck all workspaces
npm run lint                   # lint all workspaces (only @hovod/dashboard has a real eslint config)

npm run dev -w @hovod/api        # API + dashboard static server, port 3000 (tsx watch)
npm run dev -w @hovod/worker     # transcode worker (tsx watch)
npm run dev -w @hovod/dashboard  # Vite dev server, port 3001
npm run build -w @hovod/db       # shared package — must be built before api/worker
```

### Tests

There is no global test runner; each package has its own `npm test`. Several tests spin up MySQL through Docker.

```bash
npm test -w @hovod/db     # migration runner (fresh / no-op / legacy repair / failure / concurrency),
                          # URL guard, quota arithmetic, migration 0004
npm test -w @hovod/api    # keyset pagination, entitlement state machine, analytics ingestion,
                          # syncSubscription against a fake Stripe client
node scripts/check-env-docs.mjs   # every env var in api/worker env.ts is documented somewhere
```

Env switches used by the tests: `HOVOD_TEST_DATABASE_URL` (use an existing MySQL instead of Docker), `HOVOD_TEST_STACK=1` (full boot: self-host + cloud, signed webhook dedupe), `HOVOD_TEST_MYSQL_IMAGE`.

### Build order

`@hovod/db` must be built first — `@hovod/api` and `@hovod/worker` both import it. The root `npm run build` handles this via workspace ordering.

## Architecture

```
Browser ─┬─ Dashboard SPA ─┐
         └─ /embed bundle ─┤
                           ▼
                 API (Fastify :3000) ── MySQL (state) ── Redis (BullMQ)
                           │                                  │
                           │                                  ▼
                           │                        Worker (FFmpeg + AI)
                           ▼                                  │
                    S3 / CDN  ◄──────────── HLS output ───────┘
```

The API also serves the built dashboard, so a single container answers both. Playback bytes never pass through the API.

**Monorepo** (npm workspaces), 4 packages:

- **`apps/api`** — Fastify REST server.
  - `src/index.ts` — Fastify setup, plugin order (rate limiter → auth → entitlement guard), CSP, static dashboard, graceful shutdown
  - `src/db.ts` — pool + `runMigrations()` call + `bootstrapDefaultOrg()`
  - `src/env.ts` — Zod env, `superRefine` validating the cloud group together; exports `isCloud`, `appUrl`, `emailEnabled`, `apiKeySecret`, `corsOrigins`
  - `src/queue.ts` — BullMQ queues, `defaultJobOptions`, `transcodeJobId()`, the daily analytics-cleanup scheduler
  - `src/cli.ts` — `hovod-cli reset-password <email>` (prints a one-time link)
  - `src/routes/` — `assets`, `playback`, `analytics`, `ai`, `comments`, `auth`, `orgs`, `invitations`, `billing`, `settings`, `health`
  - `src/services/` — `asset` (findAssetOrFail, URL builders, cursors), `analytics`, `billing`, `billing-reconcile`, `entitlements`, `usage`, `cloud` (JWT + password + API keys), `email` (Resend), `vtt`, `webhooks`
  - `src/middleware/auth.ts` — JWT / API-key resolution, `token_version` check, scope enforcement
  - `src/middleware/error-handler.ts` — `AppError`/`NotFoundError`/`LimitError`, ZodError, honours `error.statusCode`

- **`apps/worker`** — BullMQ consumer.
  - `src/index.ts` — worker setup, startup reconciliation of orphaned jobs, job orchestration, usage accounting, webhooks
  - `src/hardware.ts` — CPU/RAM detection, cgroup v2 aware
  - `src/ffmpeg.ts` — ffmpeg/ffprobe wrappers, stderr ring buffer, duration-derived timeouts, capability probing
  - `src/transcoding.ts` — `TRANSCODING_LADDER`, HLS encode, master playlist with measured values
  - `src/thumbnails.ts` — poster + bounded sprite + VTT
  - `src/scratch.ts` — `WORK_DIR` job directories, free-space check, stale sweep
  - `src/s3.ts` — S3 client, streaming upload, per-extension `ContentType`/`CacheControl`, `S3_PUBLIC_ACL`
  - `src/ai/` — audio extraction, chunked Whisper transcription, subtitles, chapters
  - `src/analytics-worker.ts` — daily playback-session retention cleanup

- **`apps/dashboard`** — React 18 + Vite + Tailwind v4.
  - Two Vite entries: `src/main.tsx` (dashboard SPA, `index.html`) and `src/embed-main.tsx` (`embed.html`) so third-party pages never download dashboard code
  - Data layer is **TanStack Query** (`src/main.tsx` provider): no hand-rolled polling, polling pauses in a hidden tab and stops when no asset is in a transitional state
  - `src/lib/api.ts` — fetch helper, `ApiError` with `status`/`code`, 401 → `/login?from=`, 402 → `hovod:subscription-required` event
  - `src/lib/upload.ts` — S3 multipart upload (16 MB parts, 3 in parallel, per-part retry, resume)
  - `src/lib/analytics.ts` — session/viewer ids, `view_start`, heartbeats, `sendBeacon` flush
  - `src/components/Player.tsx` — aspect-ratio box, custom subtitle overlay, hls.js recovery, keyboard/touch
  - `src/lib/i18n/` — en / fr / de / es, keys typed in `types.ts`
  - `eslint.config.js` — flat config (typescript-eslint + react-hooks)

- **`packages/db`** — shared Drizzle schemas, MySQL factory, constants, migration runner, URL guard, quota helpers.
  - `src/schema.ts` — `assets`, `renditions`, `jobs`, `ai_jobs`, `playback_sessions`, `settings`, `comments`, `reactions`, `users`, `organizations`, `org_members`, `api_keys`, `stripe_events`, `usage_monthly`, `org_invitations`, `password_resets`
  - `src/client.ts` — `createDb(url, poolConfig?)`; the pool is **pinned to UTC** (`timezone: 'Z'` + `SET time_zone` per connection)
  - `src/migrations.ts` — the migration runner (see below)
  - `src/url-guard.ts` — `assertPublicHttpUrl()` SSRF guard (http(s) only, no userinfo, ports 80/443/8080/8443, every resolved address must be public)
  - `src/usage.ts` — pure quota helpers shared by API and worker (`usageMonthKey`, `quotaWouldExceed`, `quotaMessage`, …)
  - `src/constants.ts` — `ASSET_STATUS`, `JOB_STATUS`, `S3_PATHS`, `ID_LENGTH`, `ANALYTICS`, `PLAN`, `PLAN_LIMITS`, `SUBSCRIPTION_STATUS`, `ENTITLEMENT_MODE`, `TOKEN_TTL`, `GRACE_DAYS`

### Database & migrations

MySQL 8.4 / MariaDB 11.4 with Drizzle ORM (mysql2). **Migrations are versioned SQL files in `packages/db/migrations/NNNN_name.sql`**, applied at API boot by `runMigrations()` from `@hovod/db`:

- applied in lexical order, statements split on `-- >statement-breakpoint`
- recorded in the `schema_migrations` table
- serialised across replicas with `GET_LOCK('hovod_migrations', 120)`
- a failing statement throws `MigrationError` (file, statement index, MySQL error) and aborts the boot — the file is not recorded
- an existing pre-migration install (assets table present, no `schema_migrations`) goes through a one-time `legacyRepair()` and the baseline is marked applied without executing

Current files: `0001_baseline` (full v0.2.0 schema), `0002_playback_sessions`, `0003_api_hardening`, `0004_cloud`.

**Adding a migration**: create the next numbered file, add the matching Drizzle change in `src/schema.ts`, never edit an applied file. `packages/db/scripts/test-migrations.mjs` derives the expected table list from the CREATEs minus the DROPs across all files, so a new file is covered automatically.

### Asset lifecycle

`created` → (upload or import) → `uploaded` → (process) → `queued` → `processing` → `ready` | `error`

`DELETE /v1/assets/:id` is a **hard delete**: the row (renditions, jobs, sessions cascade) and every S3 object under `sources/{id}/` and `playback/{id}/`. There is no `deleted` state in the lifecycle.

`POST /v1/assets/:id/process` is only accepted from `uploaded` or `error`, uses the deterministic BullMQ job id `transcode-<assetId>`, and refuses (409) while a job is live.

### Analytics

One row per playback session in `playback_sessions`, upserted from the player's event batches (`POST /v1/analytics/events`, public, own rate-limit bucket). There is **no** raw event log and **no** background aggregation: every metric is computed from that table over the requested period (`7d` / `30d` / `90d` / `all`).

- A view = a session that actually started (`watched_sec >= 1 OR max_position_sec >= 1`), deduplicated per session, owner previews dropped server-side.
- The server resolves `playbackId` → asset/org itself; a client-supplied `assetId` is ignored.
- Sessions are purged after `ANALYTICS_RETENTION_DAYS` (default 400) by the daily cleanup job.
- All timestamps are UTC because the pool is pinned to UTC.

### Cloud mode & entitlements

`HOVOD_CLOUD=true` (API **and** worker). Everything below is inert in self-host.

- **Stripe is the source of truth.** One `syncSubscription(id)` in `services/billing.ts` mirrors the subscription into `organizations` (`plan`, `subscription_status`, `stripe_price_id`, `current_period_end`, `cancel_at_period_end`, `grace_until`, `activated_at`). Called from the Checkout return (`POST /v1/billing/sync`), the webhook, and a nightly Redis-locked reconcile.
- **Webhook idempotency** through `stripe_events` (`INSERT IGNORE` claim, released on internal error so Stripe's retry is processed).
- **Entitlement modes**: `selfhost` | `active` | `grace` (7 days after the first `past_due`) | `readonly` | `pending`. `services/entitlements.ts` registers a global `preHandler`: read-only and pending orgs may `GET`, every mutating `/v1` request answers **402**.
- **Plan limits** live in `PLAN_LIMITS` (`packages/db/src/constants.ts`). The API pre-checks cheaply; the **worker is authoritative** once the source duration is probed.
- **Usage** is MySQL-only: `usage_monthly` (UTC `YYYY-MM`, seconds) written by the worker, plus `SUM(assets.storage_bytes)`. There is no Redis metering and no Stripe Billing Meters.

### Docker image

One `Dockerfile` produces the only image. `HOVOD_ROLE` selects what runs:

| Role | Services started |
|------|------------------|
| `allinone` (default) | MariaDB + Redis + worker + API |
| `api` | API only (external `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` required) |
| `worker` | worker only (external `DATABASE_URL`, `REDIS_URL` required) |

- Supervised by **s6-overlay v3**: service definitions in `docker/rootfs/etc/hovod/s6-rc.d/`, boot hook in `docker/rootfs/etc/s6-overlay/scripts/hovod-stage2-hook`.
- Secrets (`JWT_SECRET`, MariaDB root password) are generated once and persisted in `/data/.hovod-secrets` (env > file > generated).
- API and worker run as the non-root `hovod` user; role-aware `HEALTHCHECK`; `hovod-backup` / `hovod-restore` / `hovod-cli` on the PATH.
- There are **no per-app Dockerfiles** — `apps/*/Dockerfile` were removed in v1.0.0.

## Key conventions

- Responses are `{ data: … }`; errors are `{ error: "…" }` (plus `code` when the error carries one). List endpoints add a `pagination` block (`limit`, `hasMore`, `nextCursor`, `total`).
- **402 codes**: `subscription_required`, `storage_limit`, `encoding_limit`, `ai_limit`, `api_keys_limit`, `members_limit`. Raise them with `LimitError` from `services/entitlements.ts`; the error handler serialises `{ error, code }`.
- **JWT payload is `{ sub, org, tv }`** — user id, current org id, `users.token_version` — signed HS256, valid **24 h**. It carries no tier/plan: entitlements are read from the DB (30 s cache). Bumping `token_version` (password change, `logout-all`, password reset) invalidates every earlier token.
- API keys are peppered with `API_KEY_SECRET` (falling back to `JWT_SECRET`), carry `scopes` (`read` / `read`+`write`), an optional `expires_at`, and are revoked when their creator leaves the org.
- Statuses and enums come from `@hovod/db` constants — never inline the strings.
- IDs: `nanoid` with the lengths in `ID_LENGTH` (asset 12, playback 16, …).
- DB columns are `snake_case`, Drizzle fields are `camelCase`.
- S3 paths: sources at `sources/{assetId}/input.mp4`, HLS at `playback/{assetId}/` — prefixes in `S3_PATHS`.
- ESM everywhere (`"type": "module"`), relative imports end in `.js`.
- New migration → new numbered file in `packages/db/migrations/`, never an edit to an applied one, never an ad-hoc `ALTER` at runtime.
- Worker DB updates are wrapped so a bookkeeping failure never flips a `ready` asset back to `error`.
- The dashboard's four locales (`en`, `fr`, `de`, `es`) must stay in sync with `lib/i18n/types.ts`.

## Transcoding profiles

`apps/worker/src/transcoding.ts`, `TRANSCODING_LADDER` — filtered to the source's short side, so nothing is upscaled:

| Quality | Resolution | Bitrate | Profile |
|---------|-----------|---------|---------|
| 360p    | 640×360   | 1000k   | main 3.0 |
| 480p    | 854×480   | 1800k   | main 3.1 |
| 720p    | 1280×720  | 3000k   | main 3.1 |
| 1080p   | 1920×1080 | 6000k   | high 4.0 |
| 1440p   | 2560×1440 | 10000k  | high 5.0 |
| 2160p   | 3840×2160 | 20000k  | high 5.1 |
| 4320p   | 7680×4320 | 40000k  | high 6.0 |

H.264 + AAC 128k, 6-second HLS segments with keyframes aligned to the segment boundary, VOD playlist type, `yuv420p` output (HDR PQ/HLG tone-mapped when the FFmpeg build provides `zscale`/`tonemap`). One `download.mp4` is remuxed from the highest rung.

## Scaling & hardware adaptation

Worker and API size themselves from the CPU/RAM budget (cgroup v2 limits honoured inside containers). Overridable:

| Variable | Used by | Default | Description |
|----------|---------|---------|-------------|
| `WORKER_CONCURRENCY` | Worker | `min(RAM-based, CPU-based)` | Concurrent transcode jobs |
| `FFMPEG_THREADS` | Worker | `floor(cores / concurrency)` | Threads per FFmpeg process |
| `DB_POOL_SIZE` | API, Worker | API `min(50, max(10, RAM×3))` / Worker `concurrency×2+2` | MySQL pool size |

## Environment variables

Defined in `.env.example`, documented in `docs/configuration.md` and `DOCKER.md`. API and worker each validate their own Zod schema at startup (`apps/*/src/env.ts`); cloud variables are validated as a group. The dashboard reads `VITE_API_BASE_URL` at build time only. `scripts/check-env-docs.mjs` fails if a schema variable is documented nowhere.
