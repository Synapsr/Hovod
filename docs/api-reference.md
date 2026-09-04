# API Reference

Hovod exposes a RESTful API over HTTP. Every endpoint is prefixed with `/v1/` and returns JSON.

**Base URL:** the API's public origin — `http://localhost:3000` for the all-in-one image and local dev, `http://localhost:3002` for the Compose development stack.

## Response format

Successful responses wrap the payload in `data`:

```json
{ "data": { } }
```

Errors return an `error` string, plus a machine-readable `code` when the error carries one:

```json
{ "error": "Storage limit reached (50 GB on the pro plan).", "code": "storage_limit" }
```

List endpoints add a `pagination` block next to `data`:

```json
{
  "data": [],
  "pagination": { "limit": 50, "hasMore": true, "nextCursor": "WyIyMDI2…", "total": 128 }
}
```

## HTTP status codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `202` | Accepted (analytics ingestion) |
| `400` | Validation error (missing or invalid fields) |
| `401` | Missing, invalid or expired credentials |
| `402` | Payment required — cloud mode only, see [error codes](#402-error-codes) |
| `403` | Authenticated but not allowed (insufficient role, read-only API key, registration closed) |
| `404` | Not found — also returned for a resource owned by another organization |
| `409` | Conflict with the resource's current state |
| `410` | Gone (invitation expired or already accepted) |
| `413` | Request body too large |
| `429` | Rate limit exceeded (see `Retry-After`) |
| `500` | Internal server error |

### 402 error codes

Only ever returned when the server runs in cloud mode (`HOVOD_CLOUD=true`). A self-hosted install never answers 402.

| `code` | Meaning |
|--------|---------|
| `subscription_required` | The organization has no active subscription (or it lapsed). `GET` still works; every mutating request is refused. The response also carries `status` (the Stripe status) and `entitlement`. |
| `storage_limit` | The plan's storage ceiling is reached |
| `encoding_limit` | The plan's monthly encoding minutes are exhausted |
| `ai_limit` | The plan's monthly AI minutes are exhausted |
| `api_keys_limit` | The plan's API-key ceiling is reached |
| `members_limit` | The plan's member ceiling (members + open invitations) is reached |

---

## Authentication

Every `/v1/` endpoint requires a credential except the public ones listed below.

| Header | Credential |
|--------|------------|
| `Authorization: Bearer <jwt>` | Access token from `POST /v1/auth/login`, `/v1/auth/signup`, `/v1/auth/switch-org` or an invitation acceptance. Valid **24 hours**. |
| `X-Api-Key: mk_live_…` | Organization API key (`POST /v1/orgs/:orgId/api-keys`). |

The JWT payload is `{ sub, org, tv }` (user id, current organization id, `users.token_version`), signed HS256 with `JWT_SECRET`. It carries no plan or tier — entitlements are read from the database on every request (30 s cache), so a plan change takes effect immediately.

Changing the password (`POST /v1/auth/change-password`), resetting it, or calling `POST /v1/auth/logout-all` increments `token_version` and invalidates every token issued earlier; the first two return a fresh token so the current device stays signed in.

### API key scopes

| `scopes` | Effect |
|----------|--------|
| omitted, or `["read","write"]` | Full access |
| `["read"]` | `GET`/`HEAD` only — any other method answers `403` |

A key past its `expiresAt` answers `401`. Keys are revoked automatically when the member who created them is removed from the organization.

### Public endpoints (no credential)

`GET /health/*`, `GET /v1/config`, `GET /v1/settings/public`, everything under `/v1/playback/`, `POST /v1/analytics/events`, `POST /v1/auth/{signup,login,forgot-password,reset-password}`, `POST /v1/billing/webhook`, and everything under `/v1/invitations/`.

### Rate limits

| Scope | Limit |
|-------|-------|
| Per IP, no credentials | 300 requests / minute |
| Per IP, with credentials | 1200 requests / minute |
| Rejected credentials, per IP | 10 / minute, then `429` instead of `401` |
| Per organization (after authentication) | 600 / minute self-host; the plan's `rateLimitPerMin` in cloud |
| `POST /v1/auth/{signup,login,change-password}`, `POST /v1/invitations/:token/accept` | 10 / minute / IP |
| `POST /v1/auth/{forgot-password,reset-password}` | 5 / minute / IP |
| `POST /v1/analytics/events` | 300 / minute / IP (its own bucket) |

Exceeding a limit returns `429` with a `Retry-After` header.

---

## Health & capabilities

### `GET /health/live`

Liveness probe. Always `200 { "ok": true }` while the process is up.

### `GET /health/ready`

Readiness probe. `200 { "ok": true }` when the database answers, `503 { "ok": false, "error": "Database connection failed" }` otherwise. This is what the image's `HEALTHCHECK` and your load balancer should poll.

### `GET /v1/config`

Public. What this deployment can do — used by the dashboard to decide which UI to render.

```json
{
  "data": {
    "aiAvailable": true,
    "chaptersAvailable": true,
    "cloud": false,
    "plans": [],
    "emailEnabled": false,
    "registrationEnabled": true
  }
}
```

In cloud mode `plans` lists `{ id, name, limits }` for `pro` and `business`.

---

## Auth

### `POST /v1/auth/signup`

Creates a user, an organization and the owner membership in one transaction.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `email` | string | yes | ≤ 255 characters |
| `password` | string | yes | 8–128 characters |
| `name` | string | yes | 1–255 characters |
| `orgName` | string | no | Defaults to `name` |
| `plan` | `pro` \| `business` | cloud only | **Required in cloud mode**, ignored in self-host |

**Response** `201`

```json
{ "data": { "token": "eyJ…", "user": { "id": "u1…", "email": "me@example.com", "name": "Me" },
            "org": { "id": "o1…", "slug": "me", "name": "Me" } } }
```

In cloud mode the response also carries `checkoutUrl`: the organization stays `pending` until the Stripe subscription is active, and the client should redirect there.

**Errors**: `400` (no plan in cloud mode), `403` (`REGISTRATION_ENABLED=false`, or the email domain is not in `REGISTRATION_ALLOWED_DOMAINS`), `409` (email already registered).

### `POST /v1/auth/login`

`{ email, password }` → `{ data: { token, user } }`. The token targets the most recently joined organization. `401` on bad credentials.

### `GET /v1/auth/me`

The signed-in user, their current organization, and the server's mode.

```json
{
  "data": {
    "user": { "id": "u1…", "email": "me@example.com", "name": "Me", "emailVerified": false },
    "org": {
      "id": "o1…", "name": "Acme", "slug": "acme", "role": "owner",
      "plan": null, "subscriptionStatus": null, "currentPeriodEnd": null,
      "cancelAtPeriodEnd": false, "graceUntil": null, "entitlement": "selfhost"
    },
    "cloud": false,
    "limits": null,
    "usage": { "encodingMinutes": 0, "aiMinutes": 0, "storageBytes": 0 }
  }
}
```

`entitlement` is one of `selfhost`, `active`, `grace`, `readonly`, `pending`. `limits` is `null` in self-host and the plan's `PLAN_LIMITS` entry in cloud.

### `POST /v1/auth/switch-org`

`{ orgId }` → `{ data: { token } }` — a new token scoped to another organization you are a member of. `403` when you are not.

### `POST /v1/auth/change-password`

`{ currentPassword, newPassword }` → `{ data: { success: true, token } }`. Increments `token_version`, so every other session is signed out. `401` when the current password is wrong.

### `POST /v1/auth/logout-all`

No body. Increments `token_version` and returns a fresh token for this device: `{ data: { success: true, token } }`.

### `POST /v1/auth/forgot-password`

Public. `{ email }` → always `200 { data: { sent: true, emailEnabled } }`, whether or not the account exists (no enumeration). With `RESEND_API_KEY` configured a one-time link is emailed; without it the operator issues one from the CLI:

```bash
docker exec hovod hovod-cli reset-password user@example.com    # all-in-one image
node apps/api/dist/cli.js reset-password user@example.com      # from a checkout
```

### `POST /v1/auth/reset-password`

Public. `{ token, password }` → `{ data: { success: true, token } }` (a signed-in session on the user's most recent org, or `null` when they have none). Tokens are single-use, hashed at rest and expire after **1 hour**; using one invalidates every other session. `400` when the link is invalid, expired or already used.

---

## Organizations

### `GET /v1/orgs`

Organizations the caller belongs to: `{ id, name, slug, plan, subscriptionStatus, role, entitlement }[]`.

### `POST /v1/orgs`

`{ name, plan? }` → `201 { data: { id, name, slug, token } }`. The returned token is already scoped to the new organization. In cloud mode `plan` is required and the response also carries `checkoutUrl` — one organization, one subscription.

### `GET /v1/orgs/:orgId`

Membership required. Returns the organization plus `usage`, `limits` and `entitlement`. Stripe ids are never exposed.

### `PATCH /v1/orgs/:orgId`

Owner or admin. `{ name?, webhookUrl? }`. The webhook URL must be **https** and pass the same SSRF checks as an imported source; `null` clears it.

### `GET /v1/orgs/:orgId/usage`

```json
{
  "data": {
    "usage": { "encodingMinutes": 210, "aiMinutes": 15, "storageBytes": 8123456789,
               "apiKeys": 2, "members": 3, "pendingInvitations": 1 },
    "limits": { "encodingMinutes": 500, "aiMinutes": 50, "storageGb": 50,
                "apiKeys": 5, "members": 3, "rateLimitPerMin": 300 },
    "plan": "pro",
    "entitlement": "active"
  }
}
```

`limits` and `plan` are `null` in self-host.

### API keys

| Endpoint | Method | Who |
|----------|--------|-----|
| `/v1/orgs/:orgId/api-keys` | `GET` | any member |
| `/v1/orgs/:orgId/api-keys` | `POST` | owner, admin |
| `/v1/orgs/:orgId/api-keys/:keyId` | `DELETE` | owner, admin |

**Create** — `{ name, scopes?, expiresAt? }`:

```json
{ "data": { "id": "k1…", "name": "CI", "key": "mk_live_…", "prefix": "mk_live_a1b2",
            "scopes": ["read"], "expiresAt": "2027-01-01T00:00:00.000Z" } }
```

`key` is shown **once**. `scopes` is `["read"]` or `["read","write"]` (a key that can write can always read); omitting it grants full access. `expiresAt` must be in the future.

**List** returns `id`, `name`, `keyPrefix`, `createdBy`, `expiresAt`, `scopes`, `lastUsedAt`, `createdAt` — never the key itself.

### Members

| Endpoint | Method | Who | Description |
|----------|--------|-----|-------------|
| `/v1/orgs/:orgId/members` | `GET` | any member | `id`, `userId`, `role`, `email`, `name`, `joinedAt` |
| `/v1/orgs/:orgId/members/:memberId` | `PATCH` | owner, admin | `{ role: "admin" \| "member" }` — the owner's role cannot change |
| `/v1/orgs/:orgId/members/:memberId` | `DELETE` | owner, admin | Removes the member **and revokes the API keys they created** (`revokedApiKeys` in the response). The owner cannot be removed |

### Invitations (organization side)

| Endpoint | Method | Who |
|----------|--------|-----|
| `/v1/orgs/:orgId/members/invite` | `POST` | owner, admin (only an owner may invite an `admin`) |
| `/v1/orgs/:orgId/invitations` | `GET` | owner, admin |
| `/v1/orgs/:orgId/invitations/:invitationId` | `DELETE` | owner, admin |

**Invite** — `{ email, role? }` (`role` defaults to `member`):

```json
{ "data": { "id": "i1…", "email": "new@example.com", "role": "member",
            "inviteUrl": "https://app.example.com/invite/6Yx…",
            "expiresAt": "2026-09-11T…", "emailSent": true } }
```

The invitation lasts 7 days and replaces any open invitation for the same address. `emailSent` is `false` when no mail provider is configured — hand `inviteUrl` to the person yourself. `409` when they are already a member; `402 members_limit` in cloud when members + open invitations would exceed the plan.

---

## Invitations (public)

### `GET /v1/invitations/:token`

```json
{ "data": { "orgName": "Acme", "email": "new@example.com", "role": "member",
            "requiresSignup": true, "expiresAt": "2026-09-11T…" } }
```

`404` when the token is unknown, `410` when it has expired or was already accepted.

### `POST /v1/invitations/:token/accept`

`{ password?, name? }`.

- **New account** (`requiresSignup: true`): `password` is required; the account is created with the invited address, already marked verified. → `201`
- **Existing account**: possessing the link is not enough — send either that account's `Authorization: Bearer` token or its `password`. → `200`, `401` with `code: "password_required"` otherwise.

```json
{ "data": { "token": "eyJ…", "created": true,
            "org": { "id": "o1…", "name": "Acme", "slug": "acme", "role": "member" } } }
```

---

## Assets

### `POST /v1/assets` — create

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | 1–255 characters |
| `metadata` | object | no | Custom string metadata, ≤ 10 keys, key and value ≤ 255 characters |

**Response** `201`

```json
{ "data": { "id": "a1b2c3d4e5f6", "playbackId": "p1b2c3d4e5f6g7h8", "status": "created" } }
```

In cloud mode this is where the storage / encoding pre-checks run (`402`).

### `GET /v1/assets` — list

One page of the organization's assets, newest first (`created_at DESC, id DESC`), keyset-paginated.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | — | Case-insensitive substring match on the title. `%` and `_` are matched literally |
| `status` | string | — | `created`, `uploaded`, `queued`, `processing`, `ready` or `error` |
| `sourceType` | string | — | `upload` or `url` |
| `limit` | number | `50` | 1–200 |
| `cursor` | string | — | Opaque `nextCursor` from the previous page |
| `fields` | string | `default` | `full` also returns `description`, `metadata`, `customMetadata` and `publicSettings` |

```bash
curl "http://localhost:3000/v1/assets?limit=50&q=launch" -H "Authorization: Bearer $TOKEN"
curl "http://localhost:3000/v1/assets?limit=50&q=launch&cursor=WyIyMDI2…" -H "Authorization: Bearer $TOKEN"
```

**Response** `200`

```json
{
  "data": [
    {
      "id": "a1b2c3d4e5f6",
      "orgId": "o1b2c3d4e5f6",
      "title": "My Video",
      "status": "ready",
      "playbackId": "p1b2c3d4e5f6g7h8",
      "sourceType": "upload",
      "sourceKey": "sources/a1b2c3d4e5f6/input.mp4",
      "sourceUrl": null,
      "customThumbnailKey": null,
      "durationSec": 128,
      "errorMessage": null,
      "createdAt": "2026-06-01T12:00:00.000Z",
      "updatedAt": "2026-06-01T12:05:30.000Z",
      "thumbnailUrl": "https://cdn.example.com/playback/a1b2c3d4e5f6/thumbnail.jpg",
      "hasCustomThumbnail": false
    }
  ],
  "pagination": { "limit": 50, "hasMore": true, "nextCursor": "WyIyMDI2…", "total": 128 }
}
```

`pagination.total` is present only when no filter (`q`, `status`, `sourceType`) is applied. `nextCursor` is `null` on the last page. A request with no pagination parameter still returns a page — it never dumps the whole library.

**Errors**: `400` for an invalid `cursor`, a `limit` above 200, or an unknown `status` / `sourceType`.

### `GET /v1/assets/:id` — detail

The asset with its `renditions` (each with `quality`, real probed `width`/`height`, `bitrateKbps`, `codec`, `playlistPath`, `fileSizeBytes`) plus `description`, `metadata`, `customMetadata` and `publicSettings`. `404` for an asset of another organization.

### `PATCH /v1/assets/:id` — update

`{ title?, description?, publicSettings?, metadata? }`. `publicSettings` toggles what the public pages expose:

| Key | Default | Effect |
|-----|---------|--------|
| `allowDownload` | `false` | Enables `GET /v1/playback/:playbackId/download` |
| `showTranscript` | `true` | Transcript panel on the watch page |
| `showChapters` | `true` | Chapter list |
| `showComments` | `true` | Comment section |

`400` when the body changes nothing.

### `DELETE /v1/assets/:id`

**Hard delete**: the row (renditions, jobs and playback sessions cascade) and every S3 object under `sources/{id}/` and `playback/{id}/`. Irreversible; there is no `deleted` state and no trash.

```json
{ "data": { "id": "a1b2c3d4e5f6", "deleted": true } }
```

---

## Uploading

Three ways in. Pick **presigned** for files under ~16 MB, **multipart** for anything bigger, and **direct** only when the browser cannot reach your storage.

### 1. Presigned single `PUT`

```
POST /v1/assets/:id/upload-url    → { uploadUrl, sourceKey, method: "PUT" }
PUT  <uploadUrl>                  (raw file body, Content-Type: video/mp4)
POST /v1/assets/:id/upload-complete → { id, status: "uploaded" }
```

The URL is valid for 1 hour. `upload-complete` `HEAD`s the object before promoting the asset, so a failed upload answers `400` instead of queueing a broken job.

### 2. S3 multipart (large, resumable)

```
POST /v1/assets/:id/multipart/create        → { uploadId, partSize, key }
POST /v1/assets/:id/multipart/part-url      { uploadId, partNumber }        → { url }
PUT  <url>                                   (one 16 MB part, keep the ETag)
POST /v1/assets/:id/multipart/complete      { uploadId, parts: [{ PartNumber, ETag }] }
POST /v1/assets/:id/multipart/abort         { uploadId }                     → { id, aborted: true }
```

`partSize` is 16 MiB; every part but the last must be exactly that size (S3 requires ≥ 5 MiB). Up to 10 000 parts. `complete` sorts the parts, verifies the assembled object exists and sets the status to `uploaded`; a failure answers `400` and the upload can be retried. Always `abort` an upload you give up on so storage stops holding the parts.

The dashboard's implementation (`apps/dashboard/src/lib/upload.ts`) uploads 3 parts in parallel, retries each part up to 3 times with a fresh presigned URL, and resumes from the parts it recorded in `sessionStorage`.

### 3. Direct upload through the API

```
PUT /v1/assets/:id/upload      (raw file body, up to 5 GB)
```

Writes to `UPLOAD_DIR` — which the worker must be able to read, so in a split deployment that path has to be shared storage. Only accepted while the asset is `created` (`409` otherwise). If the client disconnects mid-stream the partial file is deleted and the asset returns to `created` with a retry hint.

### 4. Import from a URL

```
POST /v1/assets/:id/import      { sourceUrl }
```

Sets the source to an external URL and moves the asset to `uploaded`; the worker downloads it when transcoding.

The URL is validated before it is stored and re-validated on every redirect the worker follows (at most 5). It is rejected when it is not `http(s)`, carries credentials (`user:pass@`), uses a port other than 80/443/8080/8443, or resolves to a private, loopback, link-local, multicast or unique-local address (IPv4, IPv6 and IPv4-mapped alike).

```json
{ "data": { "id": "a1b2c3d4e5f6", "sourceUrl": "https://example.com/video.mp4", "status": "uploaded" } }
```

---

## Processing

### `POST /v1/assets/:id/process`

Enqueues the transcode job. Optional body: `{ aiOptions: { … } }`, stored on the asset and picked up by the worker's AI phase.

```json
{ "data": { "assetId": "a1b2c3d4e5f6", "jobId": "j1k2l3m4n5o6", "status": "queued" } }
```

- Accepted only while the status is `uploaded` or `error` — anything else is `409`.
- The BullMQ job id is deterministic (`transcode-<assetId>`), so a double click cannot queue the same asset twice; a live job answers `409`.
- The queue retries twice with exponential backoff; a deterministic failure (no video stream, quota exhausted) is not retried.
- In cloud mode the API pre-checks the plan and the worker re-checks authoritatively once the source has been probed.

### `PATCH /v1/assets/:id/transcript`

`{ transcript: { segments: [{ start, end, text }], … } }` — replaces `ai/transcript.json` **and regenerates `ai/subtitles.vtt`** from the segments. Body limit 10 MB.

### `PATCH /v1/assets/:id/chapters`

`{ chapters: [{ title, startTime, endTime }] }` — replaces `ai/chapters.json`. Body limit 10 MB.

### `PUT /v1/assets/:id/thumbnail`

Raw image body (`image/jpeg`, `image/png` or `image/webp`, ≤ 10 MB). Each upload gets a unique key so the public URL changes and caches do not serve the old one; the previous custom thumbnail is deleted.

```json
{ "data": { "thumbnailUrl": "https://cdn.example.com/playback/a1…/custom-thumbnail-x1y2z3.jpg", "hasCustomThumbnail": true } }
```

### `DELETE /v1/assets/:id/thumbnail`

Drops the custom thumbnail and falls back to the auto-generated poster frame.

### `GET /v1/assets/:id/download`

A one-hour presigned download link.

| Query | Result |
|-------|--------|
| *(none)* | The original source file |
| `?quality=1080p` | The MP4 remux. Assets encoded by 0.x have one file per rendition (`playback/{id}/1080p/download.mp4`); assets encoded by 1.0 have a single `playback/{id}/download.mp4` remuxed from the highest rung, which is returned as the fallback |

```json
{ "data": { "downloadUrl": "https://…", "fileSizeBytes": 734003200 } }
```

---

## Playback

### `GET /v1/assets/:id/playback`

Authenticated and **org-scoped**: an asset id belonging to another organization answers `404`.

```json
{ "data": { "playbackId": "p1b2c3d4e5f6g7h8",
            "manifestUrl": "https://cdn.example.com/playback/a1…/master.m3u8",
            "playerUrl": "https://app.example.com/embed/p1b2c3d4e5f6g7h8" } }
```

### `GET /v1/playback/:playbackId`

**Public.** Everything a player needs. Only resolves assets whose status is `ready`.

```json
{
  "data": {
    "playbackId": "p1b2c3d4e5f6g7h8",
    "manifestUrl": "https://cdn.example.com/playback/a1…/master.m3u8",
    "playerUrl": "https://app.example.com/embed/p1b2c3d4e5f6g7h8",
    "thumbnailUrl": "https://cdn.example.com/playback/a1…/thumbnail.jpg",
    "title": "My Video",
    "description": null,
    "durationSec": 128,
    "canEdit": false,
    "publicSettings": { "allowDownload": false, "showTranscript": true, "showChapters": true, "showComments": true },
    "settings": { "primaryColor": "#4f46e5", "theme": "dark", "logoUrl": null },
    "ai": { "status": "completed", "language": "en",
            "subtitlesUrl": "https://cdn.example.com/playback/a1…/ai/subtitles.vtt",
            "chaptersUrl": "https://cdn.example.com/playback/a1…/ai/chapters.json",
            "transcriptUrl": "https://cdn.example.com/playback/a1…/ai/transcript.json" }
  }
}
```

`canEdit` is `true` when the request carries a bearer token for the owning organization — the dashboard preview uses it, and the player then suppresses its own analytics so owner previews are never counted as views. `ai` is `null` when there is no AI output.

This endpoint does **not** count a view. Views come exclusively from the player's `view_start` event.

### `GET /v1/playback/:playbackId/download`

**Public.** A one-hour presigned link to the original file — only when the asset's `publicSettings.allowDownload` is `true` (`403` otherwise).

### `GET /v1/playback/:playbackId/ai`

**Public.** The AI job's state on its own, for players that want to poll while transcription finishes.

```json
{ "data": { "status": "completed", "language": "en",
            "transcriptionStatus": "completed", "subtitlesStatus": "completed", "chaptersStatus": "completed",
            "subtitlesUrl": "…", "transcriptUrl": "…", "chaptersUrl": "…" } }
```

`{ "data": { "status": "none" } }` when the asset was never sent through the AI phase.

---

## Comments & reactions

All four endpoints are public and resolve the asset from the playback id; they only work when the asset is `ready`. Whether the UI shows them is controlled per asset by `publicSettings.showComments`.

### `POST /v1/playback/:playbackId/comments`

`{ authorName, authorEmail, body, timestampSec? }` — `body` ≤ 2000 characters, `timestampSec` pins the comment to a moment in the video. The email is never returned: responses carry an `emailHash` (Gravatar-compatible MD5) instead.

```json
{ "data": { "id": "c1…", "authorName": "Ada", "emailHash": "0bc83cb5…",
            "body": "Great demo", "timestampSec": 42, "createdAt": "2026-09-04T…" } }
```

### `GET /v1/playback/:playbackId/comments?limit=50&offset=0`

`limit` 1–200 (default 50), newest first. → `{ data: { comments: [], total } }`

### `POST /v1/playback/:playbackId/reactions`

`{ emoji, sessionId }` — toggles the reaction for that session. `emoji` is one of `fire`, `heart`, `laugh`, `clap`, `mindblown`, `sad`.

### `GET /v1/playback/:playbackId/reactions?sessionId=…`

→ `{ data: { counts: { fire: 12, heart: 3 }, userReactions: ["fire"] } }`

---

## Analytics

Analytics are session-based: the player folds everything it knows about one playback into a single `playback_sessions` row, and every number below is computed from those rows for the requested period — no background aggregation, no separate lifetime counters.

### `POST /v1/analytics/events` — ingestion

Public, its own 300 requests / minute / IP bucket. Sent by the built-in player; any third-party player can use it too.

```json
{
  "events": [
    {
      "sessionId": "k3Jd9sLm2Qw8Xz7Rt1Vb",
      "playbackId": "V1StGXR8_Z5jdHi6B",
      "viewerId": "a8Fq2LmZ9xP0oW3nT6yK",
      "type": "heartbeat",
      "timestamp": 1757000000000,
      "currentTime": 42,
      "duration": 300,
      "watchedMs": 10000,
      "qualityHeight": 720,
      "playerType": "embed",
      "referrer": "https://example.com/blog/post"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string, required | Client session id (`[A-Za-z0-9_-]{8,40}`), one per tab and playback; the built-in player keeps it in `sessionStorage` and issues a new one after 30 minutes of inactivity |
| `playbackId` | string, required | Public playback id — the asset and organization are resolved **server-side**; a client-supplied `assetId` is ignored |
| `viewerId` | string | Per-browser id (`localStorage`); distinct viewers are counted on it |
| `type` | string, required | `view_start`, `heartbeat`, `pause`, `seek`, `quality_change`, `buffer_start`, `buffer_end`, `error`, `view_end` |
| `timestamp` | number | Client clock (ms); informational — the server stamps sessions with its own UTC clock |
| `currentTime` | number | Playhead position, seconds |
| `duration` | number | Media duration, seconds |
| `watchedMs` | number | `heartbeat` / `view_end`: milliseconds actually played since the previous heartbeat (paused and hidden time excluded; clamped to 60 000 per event) |
| `qualityHeight` | number | Rendition height being played (e.g. `720`) |
| `bufferMs` | number | `buffer_end`: rebuffering duration, ms |
| `errorMessage` | string | `error`: clipped to 255 characters |
| `referrer` | string | `document.referrer`, clipped to 512 characters |
| `playerType` | string | `embed`, `watch` or `dashboard` |
| `owner` | boolean | `true` when the viewer can edit the asset. Such events are accepted and **discarded** — owner previews never count |

Semantics:

- 1 to 50 events per request. Each is validated on its own: malformed events and unknown or not-`ready` playback ids are counted in `rejected`, the rest of the batch still applies.
- Non-finite numbers (`NaN`, `Infinity`) are ignored field by field and never fail a batch.
- The built-in player sends `view_start` on the first `timeupdate` past 1 s, then a `heartbeat` every 10 s; other events are batched every 15 s and flushed with `navigator.sendBeacon` when the tab is hidden or unloaded.
- Device type is derived from `User-Agent`, the country hint from `Accept-Language`.

**Response** `202`

```json
{ "data": { "accepted": 12, "rejected": 0 } }
```

### Metric definitions

| Metric | Definition |
|--------|------------|
| **Views** | Playback sessions that actually started: `watched_sec >= 1 OR max_position_sec >= 1` |
| **Unique viewers** | `COUNT(DISTINCT viewer_id)` — sessions without a viewer id count individually |
| **Watch time** | `SUM(watched_sec)` — seconds actually played |
| **Avg. watched** | `AVG(LEAST(1, max_position_sec / duration_sec)) × 100` over views with a known duration |
| **Completion rate** | Share of views whose furthest position reached 90 % of the duration (×100) |
| **Retention curve** | 10 deciles: share of views (with a known duration) whose furthest position reached 10 %, 20 %, … 100 % |
| **Engagement score** | `0.6 × avgWatchPercent + 0.3 × completionRate + 0.1 × (100 − min(100, % of views with an error))`, rounded, 0–100 |
| **Buffer ratio** | `SUM(buffer_ms) / 1000 / SUM(watched_sec) × 100` |
| **Peak hour** | UTC hour of the day with the most session starts |

Every metric answers the same window, including the per-asset tiles. Sessions are kept `ANALYTICS_RETENTION_DAYS` days (default 400) and purged daily in batches of 10 000 rows; timestamps are stored and compared in UTC.

### `GET /v1/assets/:id/analytics?period=30d`

`period`: `7d` | `30d` (default) | `90d` | `all`. The 7-day window returns hourly buckets, the others daily.

```json
{
  "data": {
    "period": "30d",
    "granularity": "day",
    "summary": {
      "views": 128, "uniqueViewers": 97, "watchTimeSec": 15420,
      "avgWatchPercent": 61.3, "completionRate": 34.4, "engagementScore": 57,
      "errorSessions": 2, "errorCount": 3, "bufferRatio": 1.2, "bufferCount": 41, "peakHour": 20
    },
    "timeSeries": [{ "date": "2026-08-06", "views": 4, "uniqueViewers": 4, "watchTimeSec": 610 }],
    "retentionCurve": [100, 92.5, 80.1, 71.4, 62.0, 55.3, 48.9, 42.2, 37.0, 34.4],
    "peakHours": [{ "hour": 0, "views": 2 }],
    "devices": { "desktop": 80, "mobile": 41, "tablet": 7 },
    "qualityDistribution": { "360": 12, "720": 70, "1080": 46 },
    "topReferrers": [{ "referrer": "example.com", "views": 88 }, { "referrer": "(direct)", "views": 20 }]
  }
}
```

`timeSeries.date` is `YYYY-MM-DD` for daily buckets and `YYYY-MM-DDTHH:00:00Z` for hourly ones; missing buckets are zero-filled. `peakHours` always has 24 entries (UTC hours). `topReferrers` groups `http(s)` referrers by host.

### `GET /v1/analytics/overview?period=30d`

Same periods. `summary` has the same shape plus `totalAssets`; `topAssets` lists the 10 most viewed assets over the period.

```json
{
  "data": {
    "period": "30d",
    "granularity": "day",
    "summary": { "views": 512, "uniqueViewers": 380, "watchTimeSec": 60210, "avgWatchPercent": 58.0,
                 "completionRate": 31.2, "engagementScore": 54, "errorSessions": 4, "errorCount": 5,
                 "bufferRatio": 0.9, "bufferCount": 120, "peakHour": 21, "totalAssets": 14 },
    "timeSeries": [{ "date": "2026-08-06", "views": 18, "uniqueViewers": 15, "watchTimeSec": 2200 }],
    "topAssets": [{ "assetId": "abc123def456", "title": "Product demo", "views": 128,
                    "uniqueViewers": 97, "watchTimeSec": 15420, "avgWatchPercent": 61.3,
                    "completionRate": 34.4, "engagementScore": 57 }],
    "peakHours": [{ "hour": 0, "views": 6 }],
    "devices": { "desktop": 300, "mobile": 190, "tablet": 22 }
  }
}
```

---

## Settings

Branding and AI defaults, per organization.

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/v1/settings/public` | `GET` | public | `primaryColor`, `theme`, `logoUrl` of the instance defaults — used by the public pages |
| `/v1/settings` | `GET` | member | The organization's settings, including `aiAutoTranscribe` and `aiAutoChapter` |
| `/v1/settings` | `PATCH` | member | `{ primaryColor?, theme?, aiAutoTranscribe?, aiAutoChapter? }` — `primaryColor` must match `#rrggbb`, `theme` is `light` or `dark` |
| `/v1/settings/logo` | `PUT` | member | Raw image body (PNG, JPEG, SVG or WebP, ≤ 5 MB) → `{ logoUrl }` |
| `/v1/settings/logo` | `DELETE` | member | → `{ deleted: true \| false }` |

---

## Billing (cloud mode only)

These routes exist only when the server runs with `HOVOD_CLOUD=true`. Operator guide: [docs/cloud.md](cloud.md).

| Endpoint | Method | Who | Description |
|----------|--------|-----|-------------|
| `/v1/billing/checkout` | `POST` | any member | `{ plan }` → `{ checkoutUrl, url }`. The paywall's retry path. `409` `already_subscribed` when the org is `active`, `trialing` or `past_due` — use the portal instead |
| `/v1/billing/sync` | `POST` | any member | `{ sessionId }` → `{ status, entitlement, plan }`. Called on the Checkout return so activation does not wait for the webhook. `403` when the session belongs to another organization |
| `/v1/billing/portal` | `POST` | owner, admin | → `{ url }` — a Stripe customer-portal session (change plan, card, invoices, cancel). `400` `no_billing_account` before the first checkout |
| `/v1/billing/webhook` | `POST` | Stripe | Raw body, signature-verified with `STRIPE_WEBHOOK_SECRET`. Events are deduplicated through `stripe_events`; a replay answers `{ received: true, duplicate: true }`. An internal failure answers `500` and forgets the event id so Stripe's retry is processed |

Subscription state is exposed through `GET /v1/auth/me` (`org.plan`, `org.subscriptionStatus`, `org.entitlement`, `limits`, `usage`) and `GET /v1/orgs/:orgId/usage`.

---

## Embeddable player

```
https://<APP_URL>/embed/:playbackId
```

`/embed/*` is served as a standalone, lightweight bundle — third-party pages never download the dashboard. The player uses [hls.js](https://github.com/video-dev/hls.js) and falls back to native HLS on iPhone Safari. A ready-made public page is also available at `/watch/:playbackId`.

Size the iframe with the video's aspect ratio (the dashboard's **Share** dialog generates this snippet with the real ratio); the player fills the iframe and letterboxes anything of a different ratio, so the frame never scrolls:

```html
<iframe
  src="https://app.example.com/embed/p1b2c3d4e5f6g7h8"
  title="Video player"
  style="aspect-ratio:16/9;width:100%;border:0"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen
></iframe>
```

### Embed parameters

All optional query-string parameters, e.g. `/embed/p1b2c3d4e5f6g7h8?autoplay=1&muted=1&t=42&cc=1`.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `autoplay` | `1` | Attempt to start immediately. Browsers block unmuted autoplay without a user gesture — when blocked, the player retries **muted**. The host page must grant it with `allow="autoplay"` |
| `muted` | `1` | Start muted (recommended with `autoplay=1`) |
| `loop` | `1` | Restart when the video ends (the replay screen is not shown) |
| `t` | seconds | Start position, e.g. `t=90` starts at 1:30. Capped at 24 h |
| `cc` | `1` | Show captions by default when the asset has AI subtitles. Without it captions start off (the viewer's last choice is remembered for the browser session) |
| `color` | `#rrggbb` | Accent colour (progress bar, active quality). Overrides the organization's primary colour. URL-encode the `#` as `%23` |
| `title` | text | Title overlay shown while the controls are visible (≤ 200 characters, URL-encoded) |

Unknown values are ignored; `1` and `true` are both accepted for flags.

**Keyboard shortcuts** (when the player is focused): `Space`/`K` play-pause, `←`/`→` ±5 s, `J`/`L` ±10 s, `↑`/`↓` volume, `M` mute, `F` fullscreen, `C` captions, `0`–`9` seek to 0–90 %. On touch devices the first tap reveals the controls and the second toggles playback.

---

## Webhooks

Set `WEBHOOK_URL` (instance-wide) and/or an organization's `webhookUrl` (`PATCH /v1/orgs/:orgId`) to receive `POST`s:

```json
{ "type": "asset.ready", "data": { }, "timestamp": "2026-09-04T12:05:30.000Z" }
```

| `type` | When |
|--------|------|
| `asset.ready` | Transcoding finished and playback is available |
| `asset.error` | Transcoding failed (`data.errorMessage`) |
| `asset.deleted` | An asset was deleted |
| `ai.completed` | Transcription / subtitles / chapters finished |
| `ai.failed` | The AI phase failed |

Delivery is fire-and-forget with a 10 s timeout, and every target is re-validated against the SSRF guard (https required) immediately before delivery. **There are no retries yet** — durable delivery with backoff and a delivery log is on the roadmap.

---

## Complete workflow

```bash
BASE=http://localhost:3000

TOKEN=$(curl -s -X POST $BASE/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"secret123"}' | jq -r .data.token)
AUTH="Authorization: Bearer $TOKEN"

# 1. Create an asset
ASSET_ID=$(curl -s -X POST $BASE/v1/assets -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"Demo Video"}' | jq -r .data.id)

# 2. Presigned upload
UPLOAD_URL=$(curl -s -X POST $BASE/v1/assets/$ASSET_ID/upload-url -H "$AUTH" | jq -r .data.uploadUrl)
curl -X PUT "$UPLOAD_URL" -H 'Content-Type: video/mp4' --data-binary @my-video.mp4
curl -s -X POST $BASE/v1/assets/$ASSET_ID/upload-complete -H "$AUTH"

# 3. Transcode
curl -s -X POST $BASE/v1/assets/$ASSET_ID/process -H "$AUTH"

# 4. Poll
until [ "$(curl -s $BASE/v1/assets/$ASSET_ID -H "$AUTH" | jq -r .data.status)" = "ready" ]; do sleep 5; done

# 5. Share
curl -s $BASE/v1/assets/$ASSET_ID/playback -H "$AUTH" | jq
```

## Asset lifecycle

```
created ──> uploaded ──> queued ──> processing ──> ready
                            │
                            └──> error ──> (retry) ──> queued
```

| State | Description |
|-------|-------------|
| `created` | The record exists, no source file yet |
| `uploaded` | Source uploaded to S3, written to `UPLOAD_DIR`, or a URL imported |
| `queued` | Transcode job submitted |
| `processing` | The worker is transcoding |
| `ready` | Renditions generated, playback available |
| `error` | Transcoding failed — `errorMessage` carries the real FFmpeg reason and the asset can be reprocessed |

`DELETE /v1/assets/:id` removes the asset outright: there is no `deleted` state and deleted assets never appear in `GET /v1/assets`.
