# API Reference

Hovod exposes a RESTful API over HTTP. All endpoints are prefixed with `/v1/` and return JSON.

**Base URL:** `http://localhost:3002` (Docker) or `http://localhost:3000` (local dev)

## Response Format

All successful responses wrap the payload in a `data` key:

```json
{ "data": { ... } }
```

All error responses return an `error` string:

```json
{ "error": "Error message" }
```

List endpoints add a `pagination` block next to `data`:

```json
{
  "data": [ ... ],
  "pagination": { "limit": 50, "hasMore": true, "nextCursor": "WyIyMDI2…", "total": 128 }
}
```

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `400` | Validation error (missing or invalid fields) |
| `401` | Missing, invalid or expired credentials |
| `403` | Authenticated but not allowed (insufficient role, read-only API key) |
| `404` | Resource not found — also returned for a resource owned by another organization |
| `409` | Conflict with the resource's current state |
| `413` | Request body too large |
| `429` | Rate limit exceeded (see `Retry-After`) |
| `500` | Internal server error |

---

## Authentication

Every `/v1/` endpoint except the public playback, analytics-ingest and auth
endpoints requires one of:

| Header | Credential |
|--------|------------|
| `Authorization: Bearer <jwt>` | Access token from `POST /v1/auth/login` or `/v1/auth/signup`. Valid for **24 hours**. |
| `X-Api-Key: mk_live_…` | Organization API key (`POST /v1/orgs/:orgId/api-keys`). |

Access tokens carry the user's `token_version`. Changing the password
(`POST /v1/auth/change-password`) or calling `POST /v1/auth/logout-all` bumps it,
which invalidates every token issued earlier; both endpoints return a fresh token
for the current session.

API keys can be scoped and given an expiry:

| Scopes | Effect |
|--------|--------|
| omitted (or `["read","write"]`) | Full access |
| `["read"]` | `GET`/`HEAD` only — any other method answers `403` |

An expired key answers `401`. Keys are revoked automatically when the member who
created them is removed from the organization.

### Rate limits

| Scope | Limit |
|-------|-------|
| Per IP, no credentials | 300 requests / minute |
| Per IP, with credentials | 1200 requests / minute |
| Rejected credentials per IP | 10 / minute, then `429` instead of `401` |
| Per organization (after authentication) | 600 requests / minute |
| `POST /v1/auth/login`, `/v1/auth/signup`, `/v1/auth/change-password` | 10 / minute / IP |

Exceeding a limit returns `429` with a `Retry-After` header.

---

## Health

### `GET /health/live`

Liveness probe.

**Response** `200`

```json
{ "ok": true }
```

### `GET /health/ready`

Readiness probe.

**Response** `200`

```json
{ "ok": true }
```

---

## Assets

### Create Asset

```
POST /v1/assets
```

Creates a new asset in `created` state with a unique playback ID.

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Name of the video (min 1 character) |

**Example**

```bash
curl -X POST http://localhost:3002/v1/assets \
  -H "Content-Type: application/json" \
  -d '{"title": "My Video"}'
```

**Response** `201`

```json
{
  "data": {
    "id": "a1b2c3d4e5f6",
    "playbackId": "p1b2c3d4e5f6g7h8",
    "status": "created"
  }
}
```

---

### List Assets

```
GET /v1/assets
```

Returns one page of the organization's assets, newest first
(`created_at DESC, id DESC`), with keyset pagination.

**Query Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | `string` | — | Case-insensitive substring match on the title. `%` and `_` are matched literally. |
| `status` | `string` | — | One of `created`, `uploaded`, `queued`, `processing`, `ready`, `error`. |
| `sourceType` | `string` | — | `upload` or `url`. |
| `limit` | `number` | `50` | Page size, 1–200. |
| `cursor` | `string` | — | Opaque `nextCursor` from the previous page. |
| `fields` | `string` | `default` | `full` also returns `description`, `metadata`, `customMetadata` and `publicSettings`. |

The list projection omits `description`, `metadata`, `customMetadata` and
`publicSettings` unless `fields=full` is passed — fetch a single asset
(`GET /v1/assets/:id`) when you need them.

A request without any pagination parameter still returns a page (capped at 200)
plus the `pagination` block.

**Example**

```bash
# first page
curl "http://localhost:3002/v1/assets?limit=50&q=launch" \
  -H "Authorization: Bearer $TOKEN"

# next page
curl "http://localhost:3002/v1/assets?limit=50&q=launch&cursor=WyIyMDI2…" \
  -H "Authorization: Bearer $TOKEN"
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
      "createdAt": "2025-06-01T12:00:00.000Z",
      "updatedAt": "2025-06-01T12:05:30.000Z",
      "thumbnailUrl": "http://localhost:9000/hovod-vod/playback/a1b2c3d4e5f6/thumbnail.jpg",
      "hasCustomThumbnail": false
    }
  ],
  "pagination": {
    "limit": 50,
    "hasMore": true,
    "nextCursor": "WyIyMDI1LTA2LTAxVDEyOjAwOjAwLjAwMFoiLCJhMWIyYzNkNGU1ZjYiXQ",
    "total": 128
  }
}
```

`pagination.total` is only present when neither `q`, `status` nor `sourceType`
is set. `nextCursor` is `null` on the last page.

**Errors**

| Code | Reason |
|------|--------|
| `400` | Invalid `cursor`, `limit` above 200, unknown `status`/`sourceType` |

---

### Get Asset

```
GET /v1/assets/:id
```

Returns a single asset with its renditions.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Asset ID (12-character string) |

**Example**

```bash
curl http://localhost:3002/v1/assets/a1b2c3d4e5f6
```

**Response** `200`

```json
{
  "data": {
    "id": "a1b2c3d4e5f6",
    "title": "My Video",
    "status": "ready",
    "playbackId": "p1b2c3d4e5f6g7h8",
    "sourceType": "upload",
    "sourceKey": "sources/a1b2c3d4e5f6/input.mp4",
    "sourceUrl": null,
    "metadata": null,
    "durationSec": null,
    "errorMessage": null,
    "createdAt": "2025-06-01T12:00:00.000Z",
    "updatedAt": "2025-06-01T12:05:30.000Z",
    "renditions": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "assetId": "a1b2c3d4e5f6",
        "quality": "360p",
        "width": 640,
        "height": 360,
        "bitrateKbps": 800,
        "codec": "h264",
        "playlistPath": "playback/a1b2c3d4e5f6/360p/index.m3u8",
        "createdAt": "2025-06-01T12:05:28.000Z"
      },
      {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "assetId": "a1b2c3d4e5f6",
        "quality": "720p",
        "width": 1280,
        "height": 720,
        "bitrateKbps": 3000,
        "codec": "h264",
        "playlistPath": "playback/a1b2c3d4e5f6/720p/index.m3u8",
        "createdAt": "2025-06-01T12:05:29.000Z"
      },
      {
        "id": "550e8400-e29b-41d4-a716-446655440002",
        "assetId": "a1b2c3d4e5f6",
        "quality": "1080p",
        "width": 1920,
        "height": 1080,
        "bitrateKbps": 6000,
        "codec": "h264",
        "playlistPath": "playback/a1b2c3d4e5f6/1080p/index.m3u8",
        "createdAt": "2025-06-01T12:05:30.000Z"
      }
    ]
  }
}
```

**Error** `404`

```json
{ "error": "Asset not found" }
```

---

### Get Upload URL

```
POST /v1/assets/:id/upload-url
```

Generates a pre-signed S3 URL (valid for 1 hour) to upload a video file directly to storage. The client performs a `PUT` request to the returned URL with the raw video file as body.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Asset ID |

**Example**

```bash
# 1. Get the signed URL
curl -X POST http://localhost:3002/v1/assets/a1b2c3d4e5f6/upload-url

# 2. Upload the video file to the signed URL
curl -X PUT "<uploadUrl>" \
  -H "Content-Type: video/mp4" \
  --data-binary @video.mp4
```

**Response** `200`

```json
{
  "data": {
    "uploadUrl": "http://localhost:9000/hovod-vod/sources/a1b2c3d4e5f6/input.mp4?X-Amz-Algorithm=...",
    "sourceKey": "sources/a1b2c3d4e5f6/input.mp4",
    "method": "PUT"
  }
}
```

**Error** `404`

```json
{ "error": "Asset not found" }
```

---

### Import from URL

```
POST /v1/assets/:id/import
```

Sets the asset source to an external URL and transitions the status to `uploaded`. The worker will download from this URL during transcoding.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Asset ID |

**Request Body**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `sourceUrl` | `string` | Yes | Public `http`/`https` URL of the source video file |

The URL is validated before it is stored, and re-validated on every redirect the
worker follows (at most 5). It is rejected when it is not `http(s)`, carries
credentials (`user:pass@`), uses a port other than 80/443/8080/8443, or resolves
to a private, loopback, link-local, multicast or unique-local address (IPv4,
IPv6 and IPv4-mapped IPv6 alike).

**Example**

```bash
curl -X POST http://localhost:3002/v1/assets/a1b2c3d4e5f6/import \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl": "https://example.com/video.mp4"}'
```

**Response** `200`

```json
{
  "data": {
    "id": "a1b2c3d4e5f6",
    "sourceUrl": "https://example.com/video.mp4",
    "status": "uploaded"
  }
}
```

**Errors**

| Code | Reason |
|------|--------|
| `400` | Invalid URL format, or a URL that is not publicly reachable |
| `404` | Asset not found |

---

### Start Transcoding

```
POST /v1/assets/:id/process
```

Creates a transcode job and pushes it to the queue. The asset status moves to `queued`, then `processing` once the worker picks it up, and finally `ready` on completion.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Asset ID |

**Example**

```bash
curl -X POST http://localhost:3002/v1/assets/a1b2c3d4e5f6/process
```

**Response** `200`

```json
{
  "data": {
    "assetId": "a1b2c3d4e5f6",
    "jobId": "j1k2l3m4n5o6",
    "status": "queued"
  }
}
```

**Error** `404`

```json
{ "error": "Asset not found" }
```

---

### Get Playback Info

```
GET /v1/assets/:id/playback
```

Returns the HLS manifest URL and an embeddable player URL for the asset.
Requires authentication and only resolves assets belonging to the caller's
organization — any other id answers `404`.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Asset ID |

**Example**

```bash
curl http://localhost:3002/v1/assets/a1b2c3d4e5f6/playback \
  -H "Authorization: Bearer $TOKEN"
```

**Response** `200`

```json
{
  "data": {
    "playbackId": "p1b2c3d4e5f6g7h8",
    "manifestUrl": "http://localhost:9000/hovod-vod/playback/a1b2c3d4e5f6/master.m3u8",
    "playerUrl": "http://localhost:3001/embed/p1b2c3d4e5f6g7h8"
  }
}
```

**Error** `404`

```json
{ "error": "Asset not found" }
```

---

### Delete Asset

```
DELETE /v1/assets/:id
```

Permanently deletes the asset: the database row (renditions and jobs cascade)
and every S3 object under `sources/{id}/` and `playback/{id}/`. This cannot be
undone.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Asset ID |

**Example**

```bash
curl -X DELETE http://localhost:3002/v1/assets/a1b2c3d4e5f6
```

**Response** `200`

```json
{
  "data": {
    "id": "a1b2c3d4e5f6",
    "deleted": true
  }
}
```

**Error** `404`

```json
{ "error": "Asset not found" }
```

---

## Playback

### Get Public Playback

```
GET /v1/playback/:playbackId
```

Public endpoint. Returns the HLS manifest URL for a playback ID. Only works when the asset status is `ready`.

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `playbackId` | Playback ID (16-character string) |

**Example**

```bash
curl http://localhost:3002/v1/playback/p1b2c3d4e5f6g7h8
```

**Response** `200`

```json
{
  "data": {
    "manifestUrl": "http://localhost:9000/hovod-vod/playback/a1b2c3d4e5f6/master.m3u8"
  }
}
```

**Error** `404`

```json
{ "error": "Playback not found" }
```

---

## Embeddable Player

The dashboard serves an embeddable HLS player at:

```
http://localhost:3003/embed/:playbackId
```

Embed it in any page using an iframe. Size the iframe with the video's aspect ratio (the
dashboard's **Share** dialog generates this snippet with the real ratio of the asset); the
player always fills the iframe and letterboxes content of a different ratio, so the frame
never scrolls:

```html
<iframe
  src="http://localhost:3003/embed/p1b2c3d4e5f6g7h8"
  title="Video player"
  style="aspect-ratio:16/9;width:100%;border:0"
  allow="autoplay; fullscreen; picture-in-picture"
  allowfullscreen
></iframe>
```

The `/embed/*` route is served as a standalone, lightweight bundle (player only — the dashboard
code is never downloaded by third-party pages). The player uses
[hls.js](https://github.com/video-dev/hls.js) for adaptive bitrate streaming and falls back to
native HLS on Safari.

### Embed parameters

All parameters are optional query-string parameters on the embed URL, e.g.
`/embed/p1b2c3d4e5f6g7h8?autoplay=1&muted=1&t=42&cc=1`.

| Parameter | Value | Description |
|-----------|-------|-------------|
| `autoplay` | `1` | Attempt to start playback immediately. Browsers block unmuted autoplay without a user gesture — when blocked, the player retries **muted**. The host page must grant it with `allow="autoplay"` on the iframe. |
| `muted` | `1` | Start muted (recommended together with `autoplay=1`). |
| `loop` | `1` | Restart the video when it ends (the replay screen is not shown). |
| `t` | seconds | Start position, e.g. `t=90` starts at 1:30. Capped at 24 h. |
| `cc` | `1` | Show captions by default when the asset has AI subtitles. Without it captions start off in the embed (the viewer's last choice is remembered for the browser session). |
| `color` | `#rrggbb` | Accent color (progress bar, active quality). Overrides the organization's primary color. |
| `title` | text | Title overlay shown at the top of the player while the controls are visible (max 200 characters, URL-encoded). |

Unknown values are ignored; `1` and `true` are both accepted for flags.

**Keyboard shortcuts** (when the player is focused): `Space`/`K` play-pause, `←`/`→` ±5 s,
`J`/`L` ±10 s, `↑`/`↓` volume, `M` mute, `F` fullscreen, `C` captions, `0`–`9` seek to 0–90 %.
On touch devices the first tap reveals the controls and the second one toggles playback.

---

## Complete Workflow Example

```bash
# 1. Create an asset
ASSET=$(curl -s -X POST http://localhost:3002/v1/assets \
  -H "Content-Type: application/json" \
  -d '{"title": "Demo Video"}')
ASSET_ID=$(echo $ASSET | jq -r '.data.id')

# 2. Get a signed upload URL
UPLOAD=$(curl -s -X POST http://localhost:3002/v1/assets/$ASSET_ID/upload-url)
UPLOAD_URL=$(echo $UPLOAD | jq -r '.data.uploadUrl')

# 3. Upload the video
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: video/mp4" \
  --data-binary @my-video.mp4

# 4. Start transcoding
curl -s -X POST http://localhost:3002/v1/assets/$ASSET_ID/process

# 5. Poll until ready
while true; do
  STATUS=$(curl -s http://localhost:3002/v1/assets/$ASSET_ID | jq -r '.data.status')
  echo "Status: $STATUS"
  [ "$STATUS" = "ready" ] && break
  sleep 5
done

# 6. Get playback info
curl -s http://localhost:3002/v1/assets/$ASSET_ID/playback | jq
```

## Asset Lifecycle

```
created ──> uploaded ──> queued ──> processing ──> ready
                           │
                           └──> error
```

| State | Description |
|-------|-------------|
| `created` | Asset record exists, no source file yet |
| `uploaded` | Source file uploaded to S3 or URL imported |
| `queued` | Transcode job submitted to worker queue |
| `processing` | Worker is actively transcoding |
| `ready` | All renditions generated, playback available |
| `error` | Transcoding failed (see `errorMessage` field) |

`DELETE /v1/assets/:id` removes the asset outright — there is no `deleted`
state and deleted assets never appear in `GET /v1/assets`.
