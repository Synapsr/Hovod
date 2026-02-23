# Configuration

All configuration is done through environment variables. Copy `.env.example` to `.env` and adjust as needed.

```bash
cp .env.example .env
```

## Environment Variables

### Application

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `PORT` | `3000` | API server port |
| `CORS_ORIGIN` | `*` | Allowed origins. `*` for all, or comma-separated list |
| `DASHBOARD_URL` | `http://localhost:3001` | Dashboard base URL (used to generate embed player URLs) |

### Database

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | MySQL connection string. Format: `mysql://user:pass@host:port/database` |

### Redis

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://redis:6379` | Redis connection string for BullMQ job queue |

### S3 Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `S3_ENDPOINT` | — | S3 API endpoint (e.g., `http://minio:9000`) |
| `S3_REGION` | `us-east-1` | S3 region |
| `S3_BUCKET` | `hovod-vod` | Bucket name |
| `S3_ACCESS_KEY_ID` | — | S3 access key |
| `S3_SECRET_ACCESS_KEY` | — | S3 secret key |
| `S3_FORCE_PATH_STYLE` | `true` | Use path-style URLs. Set to `true` for MinIO, `false` for AWS S3 |
| `S3_PUBLIC_ENDPOINT` | — | Public-facing S3 endpoint (for signed upload URLs) |
| `S3_PUBLIC_BASE_URL` | — | Public base URL for playback manifests (e.g., `http://localhost:9000/hovod-vod`) |

### Dashboard (Build-time)

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | `http://localhost:3000` | API base URL injected at build time |

## Example Configurations

### Docker (default)

Uses the bundled MySQL, Redis, and MinIO. No changes needed:

```env
DATABASE_URL=mysql://root:root@mysql:3306/hovod
REDIS_URL=redis://redis:6379
PORT=3000

S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=hovod-vod
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_PUBLIC_BASE_URL=http://localhost:9000/hovod-vod

DASHBOARD_URL=http://localhost:3001
CORS_ORIGIN=*
VITE_API_BASE_URL=http://localhost:3002
```

### AWS S3 + RDS

```env
DATABASE_URL=mysql://admin:password@mydb.cluster-xxx.us-east-1.rds.amazonaws.com:3306/hovod
REDIS_URL=redis://my-redis.xxx.cache.amazonaws.com:6379

S3_ENDPOINT=https://s3.us-east-1.amazonaws.com
S3_REGION=us-east-1
S3_BUCKET=my-hovod-bucket
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=false
S3_PUBLIC_BASE_URL=https://my-hovod-bucket.s3.us-east-1.amazonaws.com

DASHBOARD_URL=https://dashboard.example.com
CORS_ORIGIN=https://dashboard.example.com,https://example.com
VITE_API_BASE_URL=https://api.example.com
```

### Cloudflare R2

```env
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=hovod-vod
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_BASE_URL=https://pub-xxx.r2.dev
```

## Validation

The API validates all environment variables at startup using Zod. If any required variable is missing or invalid, the server will fail to start with a descriptive error message.

The worker reads environment variables directly from `process.env` with manual validation at startup.
