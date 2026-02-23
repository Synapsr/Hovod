# Contributing to Hovod

Thanks for your interest in contributing to Hovod! This document provides guidelines and instructions for contributing.

## Getting Started

1. **Fork the repository** and clone your fork locally
2. **Install dependencies**: `npm install`
3. **Copy environment config**: `cp .env.example .env`
4. **Build the shared package first**: `npm run build -w @hovod/db`
5. **Start infrastructure**: `docker compose up -d mysql redis minio minio-init`
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

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a clear description of what changed and why
- Update documentation if your change affects the API or configuration
- Ensure `npm run typecheck` passes with no errors

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Node version, Docker version)

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
