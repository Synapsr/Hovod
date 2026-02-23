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

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `400` | Validation error (missing or invalid fields) |
| `404` | Resource not found |
| `500` | Internal server error |

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

Returns all assets ordered by creation date (newest first).

**Example**

```bash
curl http://localhost:3002/v1/assets
```

**Response** `200`

```json
{
  "data": [
    {
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
      "updatedAt": "2025-06-01T12:05:30.000Z"
    }
  ]
}
```

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
| `sourceUrl` | `string` | Yes | Valid URL to the source video file |

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
| `400` | Invalid URL format |
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

**Path Parameters**

| Parameter | Description |
|-----------|-------------|
| `id` | Asset ID |

**Example**

```bash
curl http://localhost:3002/v1/assets/a1b2c3d4e5f6/playback
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

Soft-deletes an asset by setting its status to `deleted`. The asset record and S3 objects are preserved.

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
    "status": "deleted"
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

Embed it in any page using an iframe:

```html
<iframe
  src="http://localhost:3003/embed/p1b2c3d4e5f6g7h8"
  width="100%"
  height="600"
  frameborder="0"
  allowfullscreen
></iframe>
```

The player uses [hls.js](https://github.com/video-dev/hls.js) for adaptive bitrate streaming.

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
| `deleted` | Soft-deleted via `DELETE /v1/assets/:id` |
