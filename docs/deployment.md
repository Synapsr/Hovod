# Deployment

Hovod ships as a single Docker image, `synapsr/hovod` (`ghcr.io/synapsr/hovod`), that covers every deployment size. This page is the short version; **[DOCKER.md](../DOCKER.md)** has the full reference (environment table, secrets, backups, upgrades, scaling, troubleshooting).

| Mode | When | Command |
|------|------|---------|
| [All-in-one](#all-in-one) | Getting started, VPS, small teams | `docker run … synapsr/hovod` |
| [All-in-one + external DB/Redis](#all-in-one--external-database--redis) | Single server with managed MySQL/Redis | same, plus `DATABASE_URL` / `REDIS_URL` |
| [Split with `HOVOD_ROLE`](#split-deployment-hovod_role) | Horizontal scaling, several workers, Kubernetes | `HOVOD_ROLE=api` / `HOVOD_ROLE=worker` |
| [Docker Compose](#docker-compose-development-only) | **Development only** | `docker compose up -d --build` |

You always need **S3-compatible storage** (AWS S3, Cloudflare R2, Backblaze B2, MinIO, ...): videos and HLS output live there and are streamed directly from it.

---

## All-in-one

One container with the API, the dashboard, the worker, an embedded MariaDB and an embedded Redis. Secrets are generated on first boot and persisted in the `/data` volume.

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

Open http://localhost:3000 and create the first account.

What happens inside:

1. The boot hook loads or generates `JWT_SECRET` and the MariaDB root password (`/data/.hovod-secrets`)
2. s6-overlay starts MariaDB and Redis, waits for them to accept connections
3. The API runs the database migrations and starts serving the dashboard and the API on port 3000
4. The worker connects to the queue and waits for transcoding jobs

Processes are supervised: a crashed process is restarted within a second, `docker stop` shuts everything down in order (API/worker → Redis → MariaDB). Check the status with:

```bash
docker ps                                   # (healthy)
docker logs -f hovod
docker exec hovod s6-svstat /run/service/api
```

### Backups

```bash
docker exec hovod hovod-backup                     # → /data/backups/hovod-YYYYmmdd-HHMMSS.sql.gz (keeps 7)
docker exec hovod hovod-backup - > hovod.sql.gz    # stream to a local file
docker exec -i hovod hovod-restore --yes - < hovod.sql.gz
```

### Upgrading

```bash
docker exec hovod hovod-backup
docker pull synapsr/hovod
docker stop -t 60 hovod && docker rm hovod
docker run -d --name hovod ... -v hovod-data:/data ... synapsr/hovod   # same command as before
```

Migrations run automatically at startup. Details and rollback: [DOCKER.md → Upgrading](../DOCKER.md#upgrading).

---

## All-in-one + external database / Redis

Same container; setting `DATABASE_URL` and/or `REDIS_URL` disables the embedded MariaDB / Redis:

```bash
docker run -d --name hovod --restart unless-stopped --stop-timeout 60 \
  -p 3000:3000 -v hovod-data:/data \
  -e DATABASE_URL=mysql://user:pass@db-host:3306/hovod \
  -e REDIS_URL=redis://redis-host:6379 \
  -e S3_ENDPOINT=... -e S3_REGION=... -e S3_BUCKET=... \
  -e S3_ACCESS_KEY_ID=... -e S3_SECRET_ACCESS_KEY=... \
  -e S3_PUBLIC_BASE_URL=... -e S3_FORCE_PATH_STYLE=false \
  synapsr/hovod
```

Back up the database with your provider's tooling (`hovod-backup` only covers the embedded MariaDB).

---

## Split deployment (`HOVOD_ROLE`)

The same image runs as dedicated containers. MySQL, Redis and S3 are external; every container gets the same `DATABASE_URL`, `REDIS_URL` and S3 variables, every API replica the same `JWT_SECRET`.

```bash
# API + dashboard (scale behind a load balancer)
docker run -d --name hovod-api --restart unless-stopped -p 3000:3000 \
  -e HOVOD_ROLE=api -e JWT_SECRET=$(openssl rand -hex 32) \
  -e DATABASE_URL=... -e REDIS_URL=... -e S3_ENDPOINT=... [other S3_*] \
  synapsr/hovod

# Workers (one per machine, or several)
docker run -d --name hovod-worker-1 --restart unless-stopped --stop-timeout 120 \
  -e HOVOD_ROLE=worker \
  -e DATABASE_URL=... -e REDIS_URL=... -e S3_ENDPOINT=... [other S3_*] \
  synapsr/hovod
```

`api` and `worker` never start MariaDB or Redis and exit immediately with a clear message if `DATABASE_URL`, `REDIS_URL` (or `JWT_SECRET` for the API) is missing.

A Compose file with 2 API replicas and 1 worker is provided:

```bash
cp .env.example .env    # DATABASE_URL, REDIS_URL, JWT_SECRET, S3_*
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml up -d --scale worker=3
```

> Direct uploads (`PUT /v1/assets/:id/upload`) go through `UPLOAD_DIR` (`/data/uploads`), which must be shared between the API replicas and the workers — or use pre-signed S3 uploads, which bypass it.

---

## Docker Compose (development only)

`docker-compose.yml` runs MySQL 8.4, Redis and MinIO as separate containers (ports bound to `127.0.0.1`) plus the image built from source as an `api` and a `worker` container. Default credentials, no TLS: **do not use it in production**.

```bash
git clone https://github.com/Synapsr/Hovod.git
cd Hovod
cp .env.example .env
docker compose up -d --build
```

Open http://localhost:3002 (API + dashboard). MinIO console: http://localhost:9001.

| Service | Host port | Description |
|---------|-----------|-------------|
| api | **3002** | API + dashboard |
| worker | — | Transcoding worker |
| mysql | 127.0.0.1:3306 | Database |
| redis | 127.0.0.1:6379 | Job queue |
| minio | 127.0.0.1:9000 / 9001 | S3 storage / admin console |

`docker-compose.override.yml` (merged automatically) points `api` and `worker` at the compose containers; `MYSQL_ROOT_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ENDPOINT` and the host ports (`API_PORT`, `MYSQL_PORT`, `REDIS_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`) are read from `.env` with defaults.

Stop with `docker compose down`; add `-v` to also delete the volumes (database, MinIO data).

---

## Local Development (without Docker for the apps)

Run the infrastructure with Compose and the apps with hot reload:

### Prerequisites

- **Node.js** >= 20
- **FFmpeg** (required by the worker)
- Docker (for MySQL, Redis and MinIO) — or your own instances

### Setup

```bash
git clone https://github.com/Synapsr/Hovod.git
cd Hovod
npm install
cp .env.example .env
docker compose up -d mysql redis minio minio-init
```

Point `.env` at the exposed ports:

```env
DATABASE_URL=mysql://root:root@127.0.0.1:3306/hovod
REDIS_URL=redis://127.0.0.1:6379
S3_ENDPOINT=http://127.0.0.1:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_PUBLIC_BASE_URL=http://localhost:9000/hovod-vod
VITE_API_BASE_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3001
```

### Build & Run

```bash
npm run build -w @hovod/db      # shared package first

npm run dev -w @hovod/api       # API on :3000
npm run dev -w @hovod/worker    # Worker
npm run dev -w @hovod/dashboard # Dashboard on :3001 (Vite)
```

> **Build order matters.** `@hovod/db` must be built before `@hovod/api` and `@hovod/worker`.

---

## Production checklist

- Mount `/data` on a named volume or a bind mount and **back it up** (`hovod-backup` + copy off-host; bucket versioning/replication for S3)
- `--restart unless-stopped` and `--stop-timeout 60` (or `restart:` / `stop_grace_period:` in Compose)
- Pin an image version (`synapsr/hovod:1`), read the [CHANGELOG](../CHANGELOG.md) before upgrading
- Put a reverse proxy (nginx, Caddy, Traefik) in front for TLS; raise its body size limit for direct uploads; set `APP_URL` to the public URL
- Use pre-signed uploads or shared storage for `UPLOAD_DIR` in split deployments
- Consider `REGISTRATION_ENABLED=false` or `REGISTRATION_ALLOWED_DOMAINS` once your accounts exist
