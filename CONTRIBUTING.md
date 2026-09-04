# Contributing to Hovod

Thanks for your interest in contributing to Hovod! This document provides guidelines and instructions for contributing.

## Getting Started

1. **Fork the repository** and clone your fork locally
2. **Install dependencies**: `npm install`
3. **Copy environment config**: `cp .env.example .env`
4. **Build the shared package first**: `npm run build -w @hovod/db`
5. **Start infrastructure**: `docker compose up -d mysql redis minio minio-init` (ports are bound to 127.0.0.1 — point `DATABASE_URL`, `REDIS_URL` and `S3_ENDPOINT` in `.env` at `127.0.0.1`)
6. **Start development servers**:
   ```bash
   npm run dev -w @hovod/api
   npm run dev -w @hovod/worker
   npm run dev -w @hovod/dashboard
   ```

## Development Workflow

1. **Open an issue first** to discuss what you'd like to change
2. **Create a branch** from `main` with a descriptive name (e.g., `fix/upload-timeout`, `feat/webhook-support`)
3. **Make your changes** following the code style guidelines below
4. **Test your changes** locally with the full stack running
5. **Run type checks**: `npm run typecheck`
6. **Submit a pull request** referencing the issue

## Code Style

- **TypeScript** throughout — avoid `any` types, use proper interfaces
- **ESM** modules with `.js` extensions in imports
- **camelCase** for variables and functions, **PascalCase** for types/interfaces/components
- **snake_case** for database column names (Drizzle schema maps to camelCase)
- Wrap API responses in `{ data: {...} }` for success or `{ error: "..." }` for errors
- Use the shared constants from `@hovod/db` for status values, S3 paths, and ID lengths

## Project Structure

```
apps/api/        → Fastify REST API
apps/worker/     → BullMQ transcode worker
apps/dashboard/  → React SPA (Vite + Tailwind)
packages/db/     → Shared Drizzle ORM schemas and constants
```

**Build order**: `@hovod/db` must be built before `@hovod/api` and `@hovod/worker`.

## Adding a Database Migration

The schema lives in plain SQL files under `packages/db/migrations/` and is applied
by the API at boot (see `docs/architecture.md` → *Database Migrations*). Never
edit `0001_baseline.sql` or any file that has already shipped — add a new one.

1. **Create the file** with the next 4-digit sequence number and a snake_case name:
   `packages/db/migrations/0002_add_assets_visibility.sql`. Sequence numbers must
   be contiguous and unique — the runner refuses to boot otherwise.
2. **Write one statement per chunk**, separated by a line containing exactly
   `-- >statement-breakpoint`:
   ```sql
   -- Add per-asset visibility.
   ALTER TABLE `assets` ADD COLUMN `visibility` VARCHAR(16) NOT NULL DEFAULT 'public';
   -- >statement-breakpoint
   CREATE INDEX `idx_assets_visibility` ON `assets` (`visibility`);
   ```
   MySQL DDL is not transactional: if statement 2 fails, statement 1 stays
   applied and the file is retried on the next boot. Keep files small and, where
   MySQL allows it, re-runnable (or split risky changes across files).
3. **Update the Drizzle schema** in `packages/db/src/schema.ts` so the TypeScript
   types match the new columns (the runner does not read `schema.ts`; the test
   below checks the two stay in sync for the baseline).
4. **Run the tests**: `npm test -w @hovod/db`. This validates naming/ordering,
   parses every file, and — when Docker is available — applies the migrations to a
   throwaway `mysql:8.4` container, including the legacy-upgrade path.
5. **Mention it in the PR** and in `CHANGELOG.md`. Data backfills that need
   application code (like `bootstrapDefaultOrg()`) belong in `apps/api/src/db.ts`,
   run after `runMigrations()`, and must be idempotent.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Update documentation if your change affects the API or configuration
- Ensure `npm run typecheck` passes with no errors

## Continuous Integration

Every pull request and every push to `main` / `release/**` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml):

1. **Typecheck & build** — `npm ci`, `npm run typecheck`, `npm run build` on Node 22
2. **Docker image** — builds the `linux/amd64` image (no push) and hands it to the smoke job
3. **Smoke test** — runs the all-in-one image with a MinIO container, waits for `/health/ready`, signs up via `POST /v1/auth/signup`, creates an asset with the returned token, checks that the API/worker run as `hovod` and MariaDB as `mysql`, takes a `hovod-backup`, kills the worker and verifies s6 restarts it, then checks a graceful `docker stop`

Reproduce it locally before pushing:

```bash
npm run typecheck && npm run build
docker build -t hovod:dev .
docker run --rm -e HOVOD_ROLE=api hovod:dev        # must fail fast with the list of missing variables
```

Releases ([`.github/workflows/release.yml`](.github/workflows/release.yml)) are triggered by pushing a `v*` tag (or manually with an existing tag): the image is built natively on amd64 and arm64 runners and published as a multi-arch manifest to Docker Hub (`synapsr/hovod`) and GHCR with semver tags (`1.2.3`, `1.2`, `1`, `latest`). Publishing needs the `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` repository secrets.

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Node version, Docker version)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
