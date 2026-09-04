# Self-host vs Hovod Cloud

Hovod is one codebase and one Docker image. **Hovod Cloud is that image run with `HOVOD_CLOUD=true`** on infrastructure we operate. There is no "enterprise edition", no feature held back to make the paid plan look better, and nothing in this repository is time-limited or seat-limited.

So the question is not *which product* but *who runs the servers*.

## What is identical

Everything a viewer or an editor touches:

- The full HLS ladder — 360p through 4320p (8K), HDR tone-mapping, aligned keyframes, thumbnail sprites, MP4 download.
- The dashboard, in all four languages, with every page and every setting.
- The embeddable player and the `/watch` page, with all embed parameters, captions, chapters and branding.
- Session-based analytics — the same tables, the same metrics, the same retention window.
- AI transcription, subtitles and chapters (bring your own Whisper/LLM endpoint in both cases; the cloud simply has one configured for you).
- Comments and reactions.
- Organizations, roles, invitations, API keys and scopes.
- The whole REST API, the same routes, the same shapes. The only endpoints that do not exist in self-host are `/v1/billing/*`, because there is nothing to bill.
- MIT licence, in both directions: you can leave the cloud, `docker run` the same image against a copy of your data, and keep going.

## What the cloud adds

| | What you get |
|---|---|
| **Managed infrastructure** | API replicas, dedicated encoding workers, a managed MySQL and Redis. Nothing to patch, restart or resize; encoding capacity is not your laptop's |
| **CDN delivery** | Storage on Cloudflare R2 (EU jurisdiction) behind the Cloudflare CDN, with immutable segment caching. **Streaming is not metered** — no egress bill, from us or from your object store |
| **Backups & recovery** | Daily database backups with off-site copies and a tested restore path, plus object versioning on the bucket |
| **Monitoring & upgrades** | Uptime and error monitoring, and upgrades applied for you — you never read a migration note again |
| **Email out of the box** | Invitations, password resets and account emails already configured and deliverable |
| **Support** | Email support, with an SLA on the Business plan. Self-host support is GitHub issues and discussions, best effort |

## What the cloud takes away

Honest accounting — these are real trade-offs, not fine print:

| | |
|---|---|
| **Quotas** | Each plan has monthly encoding minutes, monthly AI minutes, a storage ceiling, an API-key count and a member count. Self-host has none of these: the only limits are your CPU and your disk |
| **A bill** | A subscription per organization, and a lapsed subscription puts the organization in read-only mode (videos keep playing, nothing new can be uploaded) |
| **Your data on our servers** | Videos, metadata and analytics live in our EU infrastructure rather than yours. If that is not acceptable, self-host — and see the [100 % local & sovereign setup](../README.md#100-local--sovereign-setup) for a stack that makes zero outbound calls |
| **Our operational choices** | Storage region, retention policy, upgrade cadence and the encoding ladder are ours to set |

## Which one should you pick?

**Self-host** if you already run servers, care about data sovereignty, have unusual volume, or simply prefer owning the stack. It is free and it stays free — this is not a trial.

**Hovod Cloud** if you would rather not think about FFmpeg capacity, database backups or CDN cache headers, and you want someone to call when playback breaks. [See the plans](https://hovod.dev/#pricing).

**Both** is fine too: a self-hosted staging instance and a cloud production one run the same image and the same API, so a client written against one works against the other unchanged.

## Running your own paid service

`HOVOD_CLOUD=true` is not reserved for us — it is part of the MIT-licensed code, and [docs/cloud.md](cloud.md) is the complete operator guide: Stripe products and prices, the customer portal, webhook events, dunning policy, Resend, R2 + CDN, reconcile and a go-live checklist. Bring your own Stripe account and you can run a Hovod service of your own.

## See also

- [README → Quick start](../README.md#quick-start) — self-host in one `docker run`
- [docs/deployment.md](deployment.md) and [DOCKER.md](../DOCKER.md) — every deployment mode
- [docs/cloud.md](cloud.md) — the operator guide for paid mode
- [docs/configuration.md](configuration.md) — every environment variable
