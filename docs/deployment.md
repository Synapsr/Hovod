# Deployment

## Quick Start (Docker)

The fastest way to run Hovod. A single command spins up the API, worker, dashboard, MySQL, Redis, and MinIO.

```bash
git clone https://github.com/Synapsr/Hovod.git
cd Hovod
cp .env.example .env
docker compose up -d --build
```

That's it. Open [http://localhost:3003](http://localhost:3003) for the dashboard.

### Services & Ports

| Service | Container Port | Host Port | Description |
|---------|---------------|-----------|-------------|
| API | 3000 | **3002** | REST API |
| Dashboard | 3001 | **3003** | Web UI |
| MySQL | 3306 | 3306 | Database |
| Redis | 6379 | 6379 | Job queue |
| MinIO | 9000 | 9000 | S3 storage |
| MinIO Console | 9001 | 9001 | Storage admin UI |

### What Happens on Startup

1. **MySQL** starts and waits for healthy status
2. **Redis** starts
3. **MinIO** starts, then **minio-init** creates the `hovod-vod` bucket and sets public read on `playback/`
4. **API** runs database migrations (`CREATE TABLE IF NOT EXISTS`) and starts listening
5. **Worker** connects to Redis and waits for transcode jobs
6. **Dashboard** serves the React SPA

### Stopping

```bash
docker compose down
```

To also remove stored data (videos, database):

```bash
docker compose down -v
```

---

## Local Development

For development without Docker, you need MySQL, Redis, and an S3-compatible store running locally.

### Prerequisites

- **Node.js** >= 18
- **MySQL** 8.x
- **Redis** 7.x
- **FFmpeg** (required by the worker)
- **MinIO** or any S3-compatible storage

### Setup

```bash
git clone https://github.com/Synapsr/Hovod.git
cd Hovod
npm install
cp .env.example .env
```

Edit `.env` to point to your local services:

```env
DATABASE_URL=mysql://root:root@localhost:3306/hovod
REDIS_URL=redis://localhost:6379
S3_ENDPOINT=http://localhost:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_PUBLIC_BASE_URL=http://localhost:9000/hovod-vod
```

### Build & Run

```bash
# Build shared packages first
npm run build -w @hovod/db

# Start each service in separate terminals
npm run dev -w @hovod/api       # API on :3000
npm run dev -w @hovod/worker    # Worker
npm run dev -w @hovod/dashboard # Dashboard on :3001
```

> **Build order matters.** `@hovod/db` must be built before `@hovod/api` and `@hovod/worker`.

---

## Production Considerations

### External Database

Replace the Docker MySQL with a managed MySQL 8.x instance. Update `DATABASE_URL` in your environment:

```env
DATABASE_URL=mysql://user:password@your-rds-host:3306/hovod
```

### External S3 Storage

Hovod works with any S3-compatible storage (AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2). Update the S3 variables:

```env
S3_ENDPOINT=https://s3.amazonaws.com
S3_REGION=us-east-1
S3_BUCKET=your-bucket
S3_ACCESS_KEY_ID=your-key
S3_SECRET_ACCESS_KEY=your-secret
S3_FORCE_PATH_STYLE=false
S3_PUBLIC_BASE_URL=https://your-bucket.s3.amazonaws.com
```

### Reverse Proxy

Put a reverse proxy (nginx, Caddy, Traefik) in front to handle TLS and route traffic:

```
yourdomain.com        → dashboard (:3003)
api.yourdomain.com    → api (:3002)
```

### Scaling the Worker

The worker is stateless. Run multiple instances to process videos in parallel:

```bash
docker compose up -d --scale worker=3
```

Each worker picks jobs from the same Redis queue.
