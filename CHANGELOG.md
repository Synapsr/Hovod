# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — Hovod Cloud (optional paid mode, `HOVOD_CLOUD=true`)

Self-host installs are unchanged and unlimited; nothing below applies unless `HOVOD_CLOUD` is set. See [docs/cloud.md](docs/cloud.md).

- **Paid-only cloud mode**: signup (`POST /v1/auth/signup { …, plan }`) creates the user, a *pending* organization and a Stripe Checkout in one go (`{ token, checkoutUrl }`); the org becomes usable once the subscription is active. Additional orgs (`POST /v1/orgs { name, plan }`) start their own Checkout.
- **Stripe is the source of truth**: one `syncSubscription()` mirrors the subscription (status, plan, price, period end, cancel-at-period-end, grace deadline, activation) into `organizations` from the Checkout return (`POST /v1/billing/sync`), the webhook (`POST /v1/billing/webhook`, signature-verified and deduplicated through `stripe_events`) and a nightly reconcile (Redis-locked, 24 h with jitter). `POST /v1/billing/checkout` (paywall retry, 409 when already subscribed) and `POST /v1/billing/portal` (Stripe customer portal).
- **Entitlements**: every org is `active`, `grace` (payment failed, 7 days), `readonly` (lapsed) or `pending`; read-only and pending orgs may still `GET` but every mutating `/v1` request answers **402** `{ error, code: 'subscription_required', status }`. API keys of such orgs get the same treatment.
- **Plan limits** (Pro / Business): monthly encoding minutes, AI minutes, storage, API keys, members and per-minute rate limit. Checked cheaply by the API (`402` with `code: storage_limit | encoding_limit | api_keys_limit | members_limit`) and authoritatively by the worker once the source duration is known (job fails with `Monthly encoding quota reached (500 min). Resets on YYYY-MM-01.`; the AI phase is skipped with a message when its budget is exhausted).
- **Usage**: the worker writes `usage_monthly` (UTC month, `INSERT … ON DUPLICATE KEY UPDATE`) and `assets.storage_bytes` (source + renditions + thumbnails + AI outputs). `GET /v1/auth/me` now returns `{ user, org { …, plan, subscriptionStatus, currentPeriodEnd, cancelAtPeriodEnd, graceUntil, entitlement }, cloud, limits, usage }`; `GET /v1/orgs/:id/usage` reports counters and seats.
- **Transactional email** through the Resend REST API (`RESEND_API_KEY`, `EMAIL_FROM`; required in cloud, optional in self-host): invitations, password reset, welcome, payment failed, subscription canceled. Without it callers never fail — invitations are link-only and password resets come from the CLI.
- **Invitations** replace "add member by email": `POST /v1/orgs/:orgId/members/invite { email, role }` → `{ inviteUrl, emailSent }` (7 days), `GET /v1/orgs/:orgId/invitations`, `DELETE /v1/orgs/:orgId/invitations/:id`, public `GET /v1/invitations/:token` and `POST /v1/invitations/:token/accept { password?, name? }` (creates the account when needed, returns a token for that org).
- **Password reset** (both modes): `POST /v1/auth/forgot-password` (always 200) and `POST /v1/auth/reset-password { token, password }` (one-time, 1 hour, invalidates other sessions). CLI fallback: `node apps/api/dist/cli.js reset-password <email>` (`hovod-cli` npm script).
- `GET /v1/config` is public and reports `cloud`, `plans`, `emailEnabled`, `registrationEnabled`.
- `APP_URL` replaces `DASHBOARD_URL` (still honoured as a deprecated alias) for embed links, emails and Stripe return URLs.
- Migration `0004_cloud`: subscription columns on `organizations` (`tier` is migrated to `plan` and dropped), `users.email_verified_at`, `assets.storage_bytes`, tables `stripe_events`, `usage_monthly`, `org_invitations`, `password_resets`.

### Removed

- Organization tiers (`ORG_TIER`, `TIER_LIMITS`, `UNLIMITED_TIER_LIMITS`, the `tier` column and field), the Redis-based metering counters, the old `STRIPE_PRO_PRICE_ID` / `STRIPE_BUSINESS_PRICE_ID` variables and `GET /v1/billing/subscription`. `POST /v1/orgs/:orgId/members` (add an existing user by email) is replaced by invitations.

### Changed

- **Analytics rebuilt around playback sessions** (migration `0002_playback_sessions`): the raw event log and the hourly/daily rollup tables are replaced by one `playback_sessions` row per session, upserted from the player's event batches. Every tile of the dashboard now answers the selected period (`7d`, `30d`, `90d`, `all`), including unique viewers, completion rate, retention, devices, quality, buffering, errors and top referrers. Existing history is imported by the migration (MySQL 8.4 and MariaDB 10.11).
- Player analytics: `view_start` is sent immediately, heartbeats carry real wall-clock watch time (pauses and hidden tabs excluded), the session tail is flushed with `sendBeacon` on `visibilitychange` / `pagehide`, a reload keeps the same session (30-minute idle window), and owner previews (`canEdit`, dashboard iframe) are never counted.
- `POST /v1/analytics/events` resolves the asset from `playbackId` (a client-supplied `assetId` is ignored), validates events individually, answers `202 { accepted, rejected }` and has its own per-IP rate limit (300/min).
- Sessions are kept 400 days by default (`ANALYTICS_RETENTION_DAYS`) and purged daily in batches; the 30-day event purge and the aggregation jobs are gone.
- The MySQL pool is pinned to UTC (`timezone: 'Z'` + `SET time_zone`), so date bucketing no longer depends on the server's session time zone.

### Fixed

- Views counted twice (client + server), watch time estimated as heartbeats × 10 s, `MAX(current_time)` aggregation, the hourly `REPLACE` window destroying data, unique sessions summed across buckets, lifetime totals shrinking with the purge, sessions lost on mobile (only `beforeunload`), a new session on every reload, a `NaN` duration dropping a whole batch, and unauthenticated ingestion accepting any `assetId`.

## [0.2.0] - 2026-09-04

Reliability hotfix for self-hosters. Upgrade recommended for every install running the all-in-one image.

### Fixed

- **All-in-one image could not restart**: the embedded MariaDB root password was regenerated on every boot. Secrets (`JWT_SECRET`, MariaDB root password) are now generated once and persisted in `/data/.hovod-secrets`; installs whose password no longer matches are repaired automatically at boot.
- **Documented `docker run` quick start crashed** because `JWT_SECRET` was required but never generated.
- **Fresh installs created `jobs` without `current_step`** (an `ALTER TABLE` ran before the `CREATE TABLE`), leaving the first upload stuck in `queued` and the video page returning 500 until a restart.
- **`docker stop` hard-killed MariaDB, Redis and the worker**: the entrypoint no longer `exec`s the API, forwards SIGTERM to every process and exits when a core process dies so `--restart` policies can recover it.
- **Views were counted twice** (a server-side view on every playback metadata fetch plus the player's own). Only the player's `view_start` counts now.
- **Retention curve flat and "avg watched" absurd**: the `current_time` column was parsed by MySQL as the `CURRENT_TIME()` function.
- **10-bit / HDR / ProRes sources failed to transcode** (`FFmpeg exited with code 234`): output pixel format is now forced to `yuv420p`; streams are mapped explicitly so audio-less sources transcode.
- **FFmpeg thread limit was inert** (`-threads` was placed before `-i` and only configured the decoder).
- **AI subtitles never rendered in the player**: HLS output was uploaded without `Content-Type`; manifests, segments, VTT and images now carry correct MIME types and cache headers.
- **Embedded player never showed subtitles** even when they existed.
- **Blank embed in private browsing**: `localStorage` access is now guarded everywhere, plus a root error boundary.
- **Rate-limit (429) and body-too-large (413) responses surfaced as 500**.
- `/health/ready` returns 503 when the database is unreachable; the image now declares a `HEALTHCHECK`.
- `asset.metadata` was double-encoded when AI options were stored (reported by @leuwenn in #3).
- Poster extraction decoded the whole file (`-ss` was an output option).
- `renditions.file_size_bytes` widened to `BIGINT` (renditions over 2 GB failed the job).
- FFmpeg scratch files now live under the persistent volume (`/data/tmp`) instead of the container's overlay filesystem.

## [0.1.0] - 2026-02-13

### Added

- Initial release of Hovod
- REST API with Fastify for asset management (create, upload, import, process, delete)
- BullMQ worker for FFmpeg-based transcoding to adaptive HLS (360p/720p/1080p)
- React dashboard with upload, import, asset management, and video playback
- Embeddable HLS player with quality selector and thumbnail seek preview
- All-in-one Docker image with embedded MariaDB and Redis
- Docker Compose setup for local development
- S3-compatible storage support (AWS S3, Cloudflare R2, Backblaze B2, MinIO)
- Pre-signed URL direct uploads
- URL import from public video URLs
- Thumbnail sprite generation with WebVTT timeline
- Shared Drizzle ORM schemas via `@hovod/db` package
