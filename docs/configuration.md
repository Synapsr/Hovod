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
| `APP_URL` | `http://localhost:3000` | Public base URL of the deployment — embed player URLs, invitation / password-reset links, Stripe return URLs. Falls back to `DASHBOARD_URL` (deprecated alias) when unset |
| `JWT_SECRET` | — | **Required.** Signs access tokens (`openssl rand -hex 32`) |
| `API_KEY_SECRET` | `JWT_SECRET` | Pepper for API-key hashes; set it so `JWT_SECRET` can rotate without invalidating API keys |
| `REGISTRATION_ENABLED` | `true` | Set to `false` to close signups |
| `REGISTRATION_ALLOWED_DOMAINS` | — | Comma-separated email domains allowed to sign up |
| `WEBHOOK_URL` | — | Instance-wide receiver for asset events (`asset.ready`, `asset.error`, `asset.deleted`, `ai.completed`, `ai.failed`). Must be a public https URL; each organization can add its own with `PATCH /v1/orgs/:orgId` |
| `HOVOD_ROLE` | `allinone` | Docker image only — `allinone`, `api` or `worker`. See [DOCKER.md](../DOCKER.md#hovod_role) |

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
| `S3_PUBLIC_ACL` | `true` | Worker sets `ACL: public-read` on every playback object. Set to `false` for Cloudflare R2 or S3 buckets with ACLs disabled (Object Ownership = bucket owner enforced) — then grant public read on the `playback/` prefix at the bucket level (bucket policy, R2 public bucket / custom domain) |

### Worker

| Variable | Default | Description |
|----------|---------|-------------|
| `UPLOAD_DIR` | `/data/uploads` | Shared upload volume — the API writes direct uploads here and the Worker reads them (must be the same volume) |
| `WORK_DIR` | OS temp dir (`TMPDIR`) | Scratch directory for transcoding job files (`hovod-*` directories). Before each job the Worker checks that at least 3× the source size is free and fails the job with a clear message otherwise; leftover job directories older than 24h are swept at boot |
| `WORKER_CONCURRENCY` | auto | Concurrent transcode jobs (auto-detected from the CPU/RAM budget — cgroup v2 limits are honoured inside containers) |
| `FFMPEG_THREADS` | auto | Threads per FFmpeg process |
| `DB_POOL_SIZE` | auto | MySQL connection pool size |
| `ANALYTICS_RETENTION_DAYS` | `400` | Playback sessions older than this are purged by the daily cleanup job |

HDR sources (PQ / HLG) are tone-mapped to SDR BT.709 when the runtime FFmpeg provides the `zscale` and `tonemap` filters (the Docker image does); otherwise the Worker logs a warning at boot and falls back to a plain 8-bit conversion.

### Email (optional in self-host)

| Variable | Default | Description |
|----------|---------|-------------|
| `RESEND_API_KEY` | — | [Resend](https://resend.com) API key. When set, invitations and password-reset links are emailed |
| `EMAIL_FROM` | — | Sender, e.g. `Hovod <no-reply@example.com>`. Required together with `RESEND_API_KEY` |

Without email, invitations are link-only (the invite URL is returned to the inviter) and password resets are issued by the operator:

```bash
node apps/api/dist/cli.js reset-password user@example.com     # prints a one-time link (1 hour)
docker exec hovod hovod-cli reset-password user@example.com     # all-in-one image
```

### AI processing (optional)

Read by the worker (and mirrored on the API so `GET /v1/config` can advertise the feature). Omit them and the AI panels simply do not appear.

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_API_URL` | — | Whisper-compatible transcription endpoint (OpenAI, Groq, a local `faster-whisper-server`, …) |
| `WHISPER_API_KEY` | — | API key for that endpoint |
| `WHISPER_MODEL` | `whisper-1` | Model name, e.g. `Systran/faster-distil-whisper-large-v3` for a local server |
| `LLM_PROVIDER` | — | Chapter generation: `openai`, `anthropic`, `groq` or `custom` |
| `LLM_API_KEY` | — | API key for the LLM |
| `LLM_MODEL` | provider default | e.g. `gpt-4o-mini`, `llama-3.3-70b-versatile`, `llama3.1` |
| `LLM_API_URL` | provider default | Custom base URL (`custom` provider, or a local OpenAI-compatible server) |
| `AI_ENABLED` | worker `true`, API `false` | Set `false` to disable AI even when the keys are present |

Transcription needs `WHISPER_API_URL` **and** `WHISPER_API_KEY`; chapters additionally need `LLM_PROVIDER` and `LLM_API_KEY`. Audio is split into 10-minute chunks and merged with offset timestamps, so long recordings are not limited by the provider's 25 MB request ceiling. A fully local stack is described in the [README](../README.md#100-local--sovereign-setup).

### Cloud mode (optional — paid plans)

Leave `HOVOD_CLOUD` unset for a self-hosted install: there are no plans, no limits and Stripe is never contacted. Setting it turns the deployment into a paid-only service — see [docs/cloud.md](cloud.md) for the full operator guide.

| Variable | Description |
|----------|-------------|
| `HOVOD_CLOUD` | `true` enables cloud mode. The variables below (and `RESEND_API_KEY` / `EMAIL_FROM`) become required; the API refuses to boot if one is missing |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_live_…` / `sk_test_…`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint pointing at `POST /v1/billing/webhook` |
| `STRIPE_PRICE_PRO` | Price id of the Pro plan (recurring) |
| `STRIPE_PRICE_BUSINESS` | Price id of the Business plan (recurring) |

The worker reads `HOVOD_CLOUD` as well: it enforces the monthly encoding / AI quotas of the plan and writes usage counters.

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

APP_URL=http://localhost:3002
CORS_ORIGIN=*
VITE_API_BASE_URL=http://localhost:3000
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

APP_URL=https://dashboard.example.com
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

The Worker validates its environment the same way (Zod schema in `apps/worker/src/env.ts`).

Cloud variables are validated **as a group**: with `HOVOD_CLOUD=true`, missing any of `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, `RESEND_API_KEY` or `EMAIL_FROM` aborts the boot rather than failing at the first signup. Setting `RESEND_API_KEY` without `EMAIL_FROM` is refused in either mode.

`node scripts/check-env-docs.mjs` cross-checks both schemas against this page, `DOCKER.md`, the README and `.env.example`, and fails when a variable is documented nowhere.
