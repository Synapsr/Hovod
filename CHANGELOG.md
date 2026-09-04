# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
