# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

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
