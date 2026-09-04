# Docker Deployment Guide

Hovod ships as **one Docker image** — `synapsr/hovod` (also `ghcr.io/synapsr/hovod`) — that runs everything in a single container by default and can be split into API and worker containers for larger deployments. This guide covers every mode, the environment variables, secrets, backups, upgrades and operations.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Inside the image](#inside-the-image)
- [Deployment Modes](#deployment-modes)
  - [Mode 1: All-in-one](#mode-1-all-in-one)
  - [Mode 2: All-in-one + external database / Redis](#mode-2-all-in-one--external-database--redis)
  - [Mode 3: Split deployment with `HOVOD_ROLE`](#mode-3-split-deployment-with-hovod_role)
  - [Mode 4: Docker Compose (development only)](#mode-4-docker-compose-development-only)
- [Environment Variables](#environment-variables)
- [Secrets file](#secrets-file)
- [Volumes & Data Persistence](#volumes--data-persistence)
- [Backups](#backups)
- [Upgrading](#upgrading)
- [Health check & restart policy](#health-check--restart-policy)
- [Shutdown behaviour](#shutdown-behaviour)
- [Scaling](#scaling)
- [Building from Source](#building-from-source)
- [Networking & Ports](#networking--ports)
- [Troubleshooting](#troubleshooting)

---

## Architecture Overview

Hovod is 3 processes (API, worker, dashboard SPA served by the API) backed by 3 infrastructure services:

```
                          ┌─────────────────────────────────────────────┐
                          │              Hovod Platform                 │
                          │                                             │
  Browser ───────────────>│  ┌───────────┐         ┌───────────────┐   │
                          │  │ Dashboard │────────>│   API Server  │   │
                          │  │ (React)   │         │   (Fastify)   │   │
                          │  └───────────┘         └───────┬───────┘   │
                          │        (served by the API)     │           │
                          │                          BullMQ job        │
                          │                                │           │
                          │                        ┌───────▼───────┐   │
                          │                        │    Worker     │   │
                          │                        │   (FFmpeg)    │   │
                          │                        └───────┬───────┘   │
                          └────────────────────────────────┼───────────┘
                                                           │
                    ┌──────────────────────────────────────┼────────────────┐
                    │              Infrastructure                          │
                    │                                                       │
                    │  ┌─────────┐    ┌─────────┐    ┌──────────────────┐  │
                    │  │  MySQL  │    │  Redis  │    │  S3 Storage     │  │
                    │  │ MariaDB │    │ (queue) │    │  (videos, HLS)  │  │
                    │  └─────────┘    └─────────┘    └──────────────────┘  │
                    └──────────────────────────────────────────────────────┘
```

**Key design**: video playback is served **directly from S3** (or your CDN in front of it). The API only handles metadata and coordination, so S3 absorbs all the bandwidth.

---

## Inside the image

The image is built from the `Dockerfile` at the repository root and contains:

| Component | Details |
|-----------|---------|
| Node.js 22 | API, worker (production dependencies only, no npm at runtime) |
| Dashboard | Pre-built SPA served by the API on the same port (`@fastify/static`) |
| FFmpeg | Debian package (transcoding, thumbnails) |
| MariaDB 10.11 | Embedded database, used unless `DATABASE_URL` is set |
| Redis 7 | Embedded queue, used unless `REDIS_URL` is set |
| [s6-overlay](https://github.com/just-containers/s6-overlay) v3 | Process supervisor (PID 1) |
| `hovod-backup` / `hovod-restore` | Backup tooling for the embedded database |

### Process supervision

s6-overlay runs as PID 1 and supervises every process:

- **Boot order**: `mariadb-init` (data dir + root password) → `mariadb` and `redis` (readiness = a real login / `PING`) → `api` and `worker`. The API waits until the database accepts connections before running migrations.
- **Crash recovery**: if the API, the worker, MariaDB or Redis dies, s6 restarts it within a second — the container keeps running and the other processes are not affected.
- **Ordered shutdown** on `SIGTERM` (`docker stop`): API and worker first (they get up to 30 s to finish in-flight requests/jobs), then Redis, then MariaDB (`Normal shutdown`, InnoDB flushed).
- **Privileges**: the API and worker run as the unprivileged `hovod` user, MariaDB as `mysql`, Redis as `redis`. Only the supervisor and the boot hook run as root.
- **Fail fast**: a configuration error (missing variables, invalid `HOVOD_ROLE`) stops the container immediately with a clear message and exit code 78, before anything is started.

Useful commands:

```bash
docker exec hovod s6-svstat /run/service/api      # up (pid 274) 3600 seconds
docker exec hovod s6-svstat /run/service/worker
docker exec hovod s6-rc -d change worker           # stop the worker (e.g. maintenance)
docker exec hovod s6-rc -u change worker           # start it again
docker exec hovod s6-svc -r /run/service/api       # restart the API only
```

### `HOVOD_ROLE`

| `HOVOD_ROLE` | Starts | Embedded MariaDB/Redis | Requires |
|--------------|--------|------------------------|----------|
| `allinone` (default) | API + dashboard + worker | Yes, unless `DATABASE_URL` / `REDIS_URL` are set | S3 variables |
| `api` | API + dashboard | Never | S3 variables, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` |
| `worker` | Worker | Never | S3 variables, `DATABASE_URL`, `REDIS_URL` |

---

## Deployment Modes

### Mode 1: All-in-one

**Best for**: getting started, small teams, personal use, a single VPS.

Everything runs in one container. MariaDB and Redis are embedded and managed automatically; secrets are generated on first boot and persisted in the volume. You only provide S3 credentials.

```
┌──────────────────────────────────────────────────────┐
│                  Hovod Container                     │
│                  (port 3000)                         │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  s6-overlay (PID 1, supervision)               │  │
│  │                                                │  │
│  │  ┌──────────┐  ┌──────────┐  ┌─────────────┐  │  │
│  │  │ MariaDB  │  │  Redis   │  │   Worker    │  │  │
│  │  │ (mysql)  │  │ (redis)  │  │  (hovod)    │  │  │
│  │  └──────────┘  └──────────┘  └─────────────┘  │  │
│  │                                                │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  API + Dashboard (hovod)                 │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  /data (volume)                                      │
│  ├── mysql/           MariaDB data files             │
│  ├── redis/           Redis snapshot                 │
│  ├── .hovod-secrets   generated secrets              │
│  ├── backups/         hovod-backup output            │
│  ├── tmp/             FFmpeg scratch space           │
│  └── uploads/         direct-upload buffer           │
└──────────────────────────────────────────────────────┘
           │
           ▼
    S3 Storage (external)
```

```bash
docker run -d \
  --name hovod \
  --restart unless-stopped \
  --stop-timeout 60 \
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

Open `http://localhost:3000` — dashboard and API on the same port.

**What happens on first boot**:
1. The boot hook generates `JWT_SECRET` and a MariaDB root password and stores them in `/data/.hovod-secrets`
2. MariaDB's data directory is initialised, the root password is set, the `hovod` database is created
3. Redis starts with persistence (`save 60 1`, `maxmemory 256mb`, `noeviction`)
4. The API runs the database migrations and starts serving on port 3000; the worker connects to the queue

On subsequent boots the stored secrets are reused, so restarts, upgrades and `docker run --rm` recreations keep working as long as the `/data` volume is kept.

| Aspect | Detail |
|--------|--------|
| Image | `synapsr/hovod` |
| Port | 3000 (API + dashboard), override with `PORT` |
| Volume | `/data` — **mount it**, it holds the database |
| MySQL | Embedded MariaDB, `127.0.0.1` only |
| Redis | Embedded, `127.0.0.1` only, persisted |
| Worker | One process, hardware-adaptive concurrency |

---

### Mode 2: All-in-one + external database / Redis

**Best for**: production on a single server with a managed database (RDS, PlanetScale, ...) and/or managed Redis (ElastiCache, Upstash, ...).

Same image and role as Mode 1. Setting `DATABASE_URL` and/or `REDIS_URL` **disables** the corresponding embedded service — mix and match as you like.

```
┌──────────────────────────────────────┐
│          Hovod Container             │
│          (port 3000)                 │
│                                      │
│  ┌────────────────────────────────┐  │
│  │  API + Dashboard              │  │
│  │  Worker (FFmpeg)              │  │
│  └────────────────────────────────┘  │
│                                      │
│  (no embedded DB or Redis)           │
└──────────┬───────────────────────────┘
           │
     ┌─────┼──────────────┐
     ▼     ▼              ▼
  MySQL  Redis       S3 Storage
```

```bash
docker run -d \
  --name hovod \
  --restart unless-stopped \
  --stop-timeout 60 \
  -p 3000:3000 \
  -v hovod-data:/data \
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

```bash
# External MySQL, embedded Redis: just omit REDIS_URL
-e DATABASE_URL=mysql://user:pass@db-host:3306/hovod
```

The `/data` volume is still recommended: it keeps the generated `JWT_SECRET` (so sessions survive a recreate), the FFmpeg scratch space and the upload buffer. With an external database, `hovod-backup` is not available — use your provider's backup tooling.

---

### Mode 3: Split deployment with `HOVOD_ROLE`

**Best for**: high volume, horizontal scaling, several transcoding workers, Kubernetes.

The **same image** runs as dedicated API or worker containers; MySQL/MariaDB, Redis and S3 are external. Every container needs the same `DATABASE_URL`, `REDIS_URL`, S3 variables, and every API replica the same `JWT_SECRET`.

```
                         Load balancer / reverse proxy
                                    │
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
             ┌─────────────┐                 ┌─────────────┐
             │ HOVOD_ROLE  │                 │ HOVOD_ROLE  │
             │   = api     │                 │   = api     │   (dashboard included)
             └──────┬──────┘                 └──────┬──────┘
                    └───────────────┬───────────────┘
                                    │
                       ┌────────────▼────────────┐
                       │    Redis (managed)      │
                       │  BullMQ job queue       │
                       └────────────┬────────────┘
                                    │
                   ┌────────────────┼────────────────┐
            ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
            │ HOVOD_ROLE  │  │ HOVOD_ROLE  │  │ HOVOD_ROLE  │
            │  = worker   │  │  = worker   │  │  = worker   │
            └──────┬──────┘  └──────┬──────┘  └──────┬──────┘
                   └────────────────┼────────────────┘
                    ┌───────────────┴───────────────┐
                    ▼                               ▼
             ┌─────────────┐                 ┌─────────────┐
             │   MySQL     │                 │  S3 / CDN   │
             │ (managed)   │                 │             │
             └─────────────┘                 └─────────────┘
```

```bash
export HOVOD_ENV="-e DATABASE_URL=mysql://user:pass@db-host:3306/hovod \
  -e REDIS_URL=redis://redis-host:6379 \
  -e S3_ENDPOINT=https://s3.amazonaws.com -e S3_REGION=us-east-1 -e S3_BUCKET=my-bucket \
  -e S3_ACCESS_KEY_ID=AKIA... -e S3_SECRET_ACCESS_KEY=... -e S3_FORCE_PATH_STYLE=false \
  -e S3_PUBLIC_BASE_URL=https://cdn.example.com"

# API (+ dashboard) — as many replicas as you like behind a load balancer
docker run -d --name hovod-api-1 --restart unless-stopped -p 3000:3000 \
  -e HOVOD_ROLE=api -e JWT_SECRET=$(openssl rand -hex 32) $HOVOD_ENV synapsr/hovod

# Workers — each one auto-detects its own CPU/RAM
docker run -d --name hovod-worker-1 --restart unless-stopped --stop-timeout 120 \
  -e HOVOD_ROLE=worker $HOVOD_ENV synapsr/hovod
docker run -d --name hovod-worker-2 --restart unless-stopped --stop-timeout 120 \
  -e HOVOD_ROLE=worker $HOVOD_ENV synapsr/hovod
```

`api` and `worker` roles **never** start MariaDB or Redis. If `DATABASE_URL` or `REDIS_URL` (or `JWT_SECRET` for the API) is missing, the container exits immediately with a message listing the missing variables.

A ready-made Compose file for this layout — 2 API replicas, 1 worker, external services — is provided as [`docker-compose.prod.yml`](docker-compose.prod.yml):

```bash
cp .env.example .env    # set DATABASE_URL, REDIS_URL, JWT_SECRET, S3_*
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml up -d --scale worker=3
```

> **Direct uploads** (`PUT /v1/assets/:id/upload`) write to `UPLOAD_DIR` (`/data/uploads`) on the API and are read by the worker. In a split deployment that directory must be a volume shared by every API replica and every worker (NFS, EFS, ...), or use pre-signed S3 uploads (`POST /v1/assets/:id/upload-url`), which bypass it.

---

### Mode 4: Docker Compose (development only)

**Best for**: hacking on Hovod. **Not for production**: default credentials, MinIO, no TLS.

[`docker-compose.yml`](docker-compose.yml) runs MySQL 8.4, Redis and MinIO as separate containers (ports bound to `127.0.0.1`) plus the Hovod image built from source, split into an `api` and a `worker` container with `HOVOD_ROLE`. [`docker-compose.override.yml`](docker-compose.override.yml) is merged automatically and points the two services at the compose containers; credentials are interpolated from `.env` (`MYSQL_ROOT_PASSWORD`, `MINIO_ROOT_*`, `S3_ENDPOINT`) with working defaults.

```bash
git clone https://github.com/Synapsr/Hovod.git && cd Hovod
cp .env.example .env
docker compose up -d --build
```

| Service | Host port | Purpose |
|---------|-----------|---------|
| `api` | **3002** | API + dashboard → http://localhost:3002 |
| `worker` | — | Transcoding worker |
| `mysql` | 127.0.0.1:3306 | Database |
| `redis` | 127.0.0.1:6379 | Job queue |
| `minio` | 127.0.0.1:9000 / 9001 | S3 storage / web console |

Override the host ports in `.env`: `API_PORT`, `MYSQL_PORT`, `REDIS_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`.

To work on the code with hot reload, start only the infrastructure and run the apps with `npm run dev` (see [CONTRIBUTING.md](CONTRIBUTING.md)):

```bash
docker compose up -d mysql redis minio minio-init
```

---

## Environment Variables

### Required (every mode)

| Variable | Description |
|----------|-------------|
| `S3_ENDPOINT` | S3-compatible endpoint URL |
| `S3_REGION` | S3 region |
| `S3_BUCKET` | S3 bucket name |
| `S3_ACCESS_KEY_ID` | S3 access key |
| `S3_SECRET_ACCESS_KEY` | S3 secret key |
| `S3_PUBLIC_BASE_URL` | Public URL of the bucket (HLS playback, posters) — not needed by the `worker` role |

### Required for external services / split roles

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MySQL connection string (`mysql://user:pass@host:3306/db`). Optional in `allinone` (embedded MariaDB otherwise), **required** for `api` and `worker` |
| `REDIS_URL` | Redis connection string (`redis://host:6379`). Optional in `allinone` (embedded Redis otherwise), **required** for `api` and `worker` |
| `JWT_SECRET` | Secret for auth tokens (≥ 32 chars, `openssl rand -hex 32`). Generated and persisted automatically in `allinone`; **required** for the `api` role and must be identical on every replica |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `HOVOD_ROLE` | `allinone` | `allinone`, `api` or `worker` — see [HOVOD_ROLE](#hovod_role) |
| `PORT` | `3000` | API/dashboard port inside the container |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style S3 URLs (set `false` for AWS S3) |
| `S3_PUBLIC_ENDPOINT` | same as `S3_ENDPOINT` | Public S3 endpoint used for browser uploads (pre-signed URLs) |
| `CORS_ORIGIN` | `*` | Allowed CORS origins (comma-separated) |
| `DASHBOARD_URL` | `http://localhost:3001` | Public URL of the dashboard (embed/share links) |
| `UPLOAD_DIR` | `/data/uploads` | Direct-upload buffer (API writes, worker reads) |
| `WORK_DIR` | `/data/tmp` | FFmpeg scratch space (worker `TMPDIR`) |
| `MARIADB_ROOT_PASSWORD` | generated | Root password of the embedded MariaDB (env wins over the persisted one; the data directory is repaired to match) |
| `REDIS_MAXMEMORY` | `256mb` | `maxmemory` of the embedded Redis (`noeviction` policy) |
| `HOVOD_BACKUP_KEEP` | `7` | Backups kept by `hovod-backup` (`0` = keep all) |
| `REGISTRATION_ENABLED` | `true` | Set `false` to disable new signups |
| `REGISTRATION_ALLOWED_DOMAINS` | — | Comma-separated list of allowed signup email domains |
| `WEBHOOK_URL` | — | Webhook receiver for asset events |
| `NODE_ENV` | `production` | Node environment |

AI (`WHISPER_*`, `LLM_*`, `AI_ENABLED`) and billing (`STRIPE_*`) variables are documented in [`.env.example`](.env.example) and [docs/configuration.md](docs/configuration.md).

### Scaling (auto-detected, override via env)

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKER_CONCURRENCY` | auto | Concurrent transcode jobs per worker |
| `FFMPEG_THREADS` | auto | Threads per FFmpeg process |
| `DB_POOL_SIZE` | auto | MySQL connection pool size |

The worker logs its computed configuration at startup. See [Scaling](#scaling).

### s6-overlay tuning (advanced)

| Variable | Default | Description |
|----------|---------|-------------|
| `S6_CMD_WAIT_FOR_SERVICES_MAXTIME` | `300000` | Max time (ms) to wait for MariaDB/Redis readiness at boot (InnoDB recovery on a large DB) |
| `S6_KILL_GRACETIME` | `5000` | Grace (ms) between SIGTERM and SIGKILL for leftover processes at shutdown |
| `S6_VERBOSITY` | `2` | s6 log verbosity (`1` hides the `s6-rc: info:` lines) |

---

## Secrets file

In `allinone` mode the container needs two secrets it can generate itself: `JWT_SECRET` and the embedded MariaDB root password. They are stored in **`/data/.hovod-secrets`** (`root:root`, mode `600`):

```
JWT_SECRET=...
MARIADB_ROOT_PASSWORD=...
```

Precedence at boot: **environment variable → secrets file → generated** (then persisted). Set `JWT_SECRET` explicitly if you want to control it; rotating it invalidates every session and API token.

The API and worker never read that file: the boot hook (root) loads it and hands the values to the processes through s6's container environment, so the `hovod` user only ever sees them in its own environment.

Keep the file with the volume — losing it means losing the MariaDB root password. If it does get lost, the container generates a new password and **repairs the data directory to match** at the next boot (that is also how installs created by 0.1.0, which regenerated the password on every boot, are fixed).

---

## Volumes & Data Persistence

### All-in-one

| Path | Content | Critical |
|------|---------|----------|
| `/data/mysql/` | MariaDB data files | **Yes** — all metadata, users, analytics |
| `/data/.hovod-secrets` | Generated secrets | **Yes** — see above |
| `/data/backups/` | `hovod-backup` dumps | Copy them off-host |
| `/data/redis/` | Redis snapshot | Low — queue state only |
| `/data/uploads/` | Direct-upload buffer | Transient |
| `/data/tmp/` | FFmpeg scratch space | Transient (cleaned at boot) |

```bash
docker run -v hovod-data:/data ...          # named volume (recommended)
docker run -v /srv/hovod:/data ...          # bind mount
```

Video sources and HLS output are in **S3**, not in the volume.

The volume is initialised owned by `hovod`; at every boot the hook fixes ownership of the subdirectories (`mysql` → `mysql`, `redis` → `redis`, `tmp` → `1777`), so bind mounts work with any host uid.

### Split / Compose

| Volume | Used by | Content |
|--------|---------|---------|
| `uploads` | API + worker | Direct-upload buffer (shared) |
| `mysql-data`, `redis-data`, `minio-data` | dev stack | Infrastructure data |

---

## Backups

Two commands are installed in the image and operate on the **embedded MariaDB** (they refuse to run when `DATABASE_URL` points elsewhere — use your provider's tooling in that case). S3 content is not included: back up the bucket with your storage provider (versioning, replication).

### `hovod-backup`

```bash
docker exec hovod hovod-backup
# /data/backups/hovod-20260904-121409.sql.gz
```

- `mariadb-dump --single-transaction` (consistent, no locking of the running app) → gzip
- Written to `/data/backups/hovod-YYYYmmdd-HHMMSS.sql.gz` (`root`, mode 600); the path is printed on stdout
- Keeps the last **7** by default (`HOVOD_BACKUP_KEEP=30` to keep more, `0` to keep all)
- `hovod-backup -` streams the dump to stdout instead, handy for off-host copies:

```bash
docker exec hovod hovod-backup - > hovod-$(date +%F).sql.gz
```

Schedule it from the host, e.g. cron every night:

```cron
0 3 * * * docker exec hovod hovod-backup >/dev/null && rsync -a /var/lib/docker/volumes/hovod-data/_data/backups/ backup-host:/backups/hovod/
```

### `hovod-restore` and the restore drill

```bash
docker exec hovod hovod-restore /data/backups/hovod-20260904-121409.sql.gz   # asks for confirmation
docker exec -i hovod hovod-restore --yes - < hovod-2026-09-04.sql.gz           # from a local file
```

The restore stops the API and worker, replaces the `hovod` database, then starts them again. Practise it before you need it:

```bash
# 1. Take a backup and copy it out of the container
docker exec hovod hovod-backup - > drill.sql.gz

# 2. Restore it (idempotent: the data is the same before and after)
docker exec -i hovod hovod-restore --yes - < drill.sql.gz

# 3. Check the app is back
curl -s http://localhost:3000/health/ready       # {"ok":true}
```

Restoring into a **fresh** container (disaster recovery): start the new container with an empty volume, wait for `/health/ready`, then run the restore. The new `JWT_SECRET` differs from the old one, so users have to log in again — copy the old `/data/.hovod-secrets` in before the first boot (or pass `JWT_SECRET`) to keep sessions.

---

## Upgrading

1. **Backup**: `docker exec hovod hovod-backup` (and copy the file off-host)
2. **Pull**: `docker pull synapsr/hovod:latest` (or a specific version, `synapsr/hovod:1.2.3`)
3. **Stop**: `docker stop -t 60 hovod` — MariaDB shuts down cleanly
4. **Recreate** with the same `docker run` command and the same `/data` volume:
   ```bash
   docker rm hovod
   docker run -d --name hovod ... -v hovod-data:/data ... synapsr/hovod:latest
   ```
5. Migrations run **automatically** when the API starts; watch them with `docker logs -f hovod` and wait for `Hovod is ready`.

With Compose: `docker compose pull && docker compose up -d`.

Always upgrade **one major version at a time** and read the [CHANGELOG](CHANGELOG.md). To roll back, stop the container, start the previous image tag with the same volume, and `hovod-restore` the backup taken in step 1 if the schema changed.

Pin a version in production (`synapsr/hovod:1`, `synapsr/hovod:1.2`) rather than `latest`. Images are published for `linux/amd64` and `linux/arm64`.

---

## Health check & restart policy

The image declares a `HEALTHCHECK` (every 30 s, 90 s start period, 3 retries):

- `allinone` / `api`: `GET /health/ready` must return 200 — it returns 503 when the database is unreachable
- `worker`: the supervised worker process must be up

`docker ps` shows `(healthy)` / `(unhealthy)`; orchestrators and load balancers can use `/health/ready` (readiness) and `/health/live` (liveness).

Always run with a restart policy: `--restart unless-stopped` (or `restart: unless-stopped` in Compose). Note that Docker does **not** restart a container because it became unhealthy — s6 already restarts crashed processes inside the container, and the restart policy covers the container itself (host reboot, OOM kill of PID 1). A configuration error exits with code 78 and would loop under a restart policy: check `docker logs` if the container keeps restarting.

---

## Shutdown behaviour

`docker stop` sends `SIGTERM` to s6, which brings the services down in reverse dependency order:

1. `api` and `worker` get `SIGTERM` and up to **30 s** to finish (a transcoding job in progress is interrupted and retried later by BullMQ)
2. `redis` saves its snapshot and exits
3. `mariadb` performs a **normal shutdown** (`docker logs` shows `mysqld: Normal shutdown` ... `Shutdown complete`)

Docker's own kill timeout must be longer than that: use `docker stop -t 60` / `--stop-timeout 60` on `docker run` / `stop_grace_period: 60s` in Compose. The default 10 s can hard-kill MariaDB mid-shutdown (InnoDB recovers at the next boot, but it is slower and avoidable).

---

## Scaling

### How auto-detection works

At startup, the worker reads the CPU core count and total RAM it can see to compute (set `WORKER_CONCURRENCY` / `FFMPEG_THREADS` explicitly when the container runs with CPU/memory limits):

```
Concurrency    = max(1, min( floor((RAM - 1GB) / 1.5GB), floor(cores / 4) ))
FFmpeg threads = max(1, floor(cores / concurrency))
DB pool        = max(5, concurrency * 2 + 2)
```

| Machine | Concurrency | FFmpeg threads | DB pool |
|---------|-------------|----------------|---------|
| 2 cores, 4 GB | 1 job | 2 | 5 |
| 4 cores, 8 GB | 1 job | 4 | 5 |
| 8 cores, 16 GB | 2 jobs | 4 | 6 |
| 16 cores, 32 GB | 4 jobs | 4 | 10 |
| 32 cores, 64 GB | 8 jobs | 4 | 18 |

### Horizontal scaling (multiple workers)

Workers are stateless. Run as many `HOVOD_ROLE=worker` containers as you like against the same Redis queue — each auto-detects its own hardware, heterogeneous machines are fine:

```bash
docker compose -f docker-compose.prod.yml up -d --scale worker=3
```

### API scaling

The API is stateless (all state lives in MySQL/Redis/S3). Run several `HOVOD_ROLE=api` replicas behind a load balancer with the **same `JWT_SECRET`**.

---

## Building from Source

```bash
git clone https://github.com/Synapsr/Hovod.git && cd Hovod
docker build -t hovod .
docker build --platform linux/amd64 -t hovod:amd64 .     # cross-build (needs buildx/QEMU)
```

The Dockerfile is multi-stage: a `build` stage compiles every workspace, a `deps` stage installs production dependencies only (`npm ci --omit=dev`), an `s6` stage downloads and checksum-verifies s6-overlay for the target architecture, and the runtime stage assembles the result on `node:22-bookworm-slim` with Debian's FFmpeg, MariaDB and Redis. Build metadata can be passed with `--build-arg VERSION=… --build-arg VCS_REF=… --build-arg BUILD_DATE=…` (OCI labels).

Releases are built by [`.github/workflows/release.yml`](.github/workflows/release.yml) on native amd64 and arm64 runners and merged into one multi-arch manifest.

---

## Networking & Ports

### All-in-one / api role

| Port | Service |
|------|---------|
| **3000** (`PORT`) | API + dashboard |

Embedded MariaDB and Redis listen on `127.0.0.1` only (never exposed).

### Compose (development)

| Host port | Service |
|-----------|---------|
| **3002** | API + dashboard |
| 127.0.0.1:3306 | MySQL |
| 127.0.0.1:6379 | Redis |
| 127.0.0.1:9000 / 9001 | MinIO S3 API / console |

### Reverse proxy

Put nginx, Caddy or Traefik in front of port 3000 for TLS. Direct uploads can be large: raise the proxy's body size limit (`client_max_body_size 0;` in nginx) or use pre-signed S3 uploads. Set `DASHBOARD_URL` to the public URL so embed/share links are correct.

---

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| Container exits immediately, exit code 78 | Configuration error — `docker logs hovod` lists the missing variables |
| `docker ps` shows `(unhealthy)` | `curl http://localhost:3000/health/ready`; database down or unreachable (`docker logs hovod`) |
| `s6-rc: warning: unable to start service mariadb` | MariaDB did not become ready within `S6_CMD_WAIT_FOR_SERVICES_MAXTIME`; look for InnoDB errors above it, check disk space |
| `Stored root password does not match the data directory — repairing` | Expected once after upgrading from 0.1.0 or after changing `MARIADB_ROOT_PASSWORD`; harmless |
| Worker restarts in a loop | `docker logs hovod | grep worker` — usually S3 credentials or `REDIS_URL` |
| Uploads fail in a split deployment | `UPLOAD_DIR` is not shared between API and worker, or use pre-signed uploads |

Process status inside the container:

```bash
docker exec hovod ps -eo user,pid,comm
for s in api worker mariadb redis; do docker exec hovod s6-svstat /run/service/$s; done
```

---

## Quick Reference

| I want to... | Use |
|--------------|-----|
| Try Hovod in 30 seconds | [Mode 1: All-in-one](#mode-1-all-in-one) |
| Run in production on a VPS | Mode 1 + [backups](#backups), or [Mode 2](#mode-2-all-in-one--external-database--redis) with a managed DB |
| Scale for high volume | [Mode 3: Split with `HOVOD_ROLE`](#mode-3-split-deployment-with-hovod_role) |
| Develop locally | [Mode 4: Docker Compose](#mode-4-docker-compose-development-only) |
| Upgrade | [Upgrading](#upgrading) |
| Back up / restore | [Backups](#backups) |
