# Hovod Cloud — operator guide

`HOVOD_CLOUD=true` turns a Hovod deployment into a **paid-only** service: signup starts a Stripe Checkout, every organization needs an active subscription, and plan limits are enforced. This is how [hovod.dev](https://hovod.dev) runs. A self-hosted install never needs any of this — leave `HOVOD_CLOUD` unset and Hovod stays unlimited and never contacts Stripe.

**Contents**: [what changes](#1-what-cloud-mode-changes) · [environment](#2-environment) · [Stripe setup](#3-stripe-setup-once-in-the-stripe-dashboard) · [plans & limits](#4-plans-and-limits) · [subscription lifecycle](#5-subscription-lifecycle) · [data model](#6-data-model-migration-0004_cloud) · [email (Resend)](#7-email-resend) · [storage & CDN](#8-storage-and-cdn-cloudflare-r2) · [DNS & hosting](#9-dns-and-hosting) · [go-live checklist](#10-go-live-checklist) · [operations](#11-operations-cheat-sheet)

## 1. What cloud mode changes

| | Self-host (default) | Cloud (`HOVOD_CLOUD=true`) |
|---|---|---|
| Signup | open (`REGISTRATION_*` respected), org active immediately | creates the user + a **pending** org + a Stripe Checkout; the org becomes active when the subscription is |
| Plans / limits | none, unlimited | `pro` / `business` (see [§4](#4-plans-and-limits)) |
| Stripe | never loaded | required (`STRIPE_*`) |
| Email | optional (`RESEND_API_KEY`); without it invitations are link-only and password reset is CLI-only | required (`RESEND_API_KEY`, `EMAIL_FROM`) |
| Entitlement check | none | every mutating `/v1` request needs an active (or in-grace) subscription |

## 2. Environment

| Variable | Notes |
|---|---|
| `HOVOD_CLOUD` | `true` — API **and** worker |
| `APP_URL` | public base URL, e.g. `https://app.hovod.dev` (Checkout return URLs, portal return URL, email links) |
| `STRIPE_SECRET_KEY` | `sk_live_…` (or `sk_test_…` on a test deployment) |
| `STRIPE_WEBHOOK_SECRET` | signing secret of the webhook endpoint (§3.3) |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` | recurring price ids (§3.1) |
| `STRIPE_PORTAL_CONFIGURATION_ID` | *optional* — customer-portal configuration (`bpc_…`). Required when the Stripe account also serves another product, whose default portal configuration would not list Hovod's prices (§3.2) |
| `RESEND_API_KEY`, `EMAIL_FROM` | [Resend](https://resend.com) key + verified sender (`Hovod <no-reply@hovod.dev>`) |
| `REDIS_URL` | already required — also used for the reconcile lock |

The API validates the whole group at boot: with `HOVOD_CLOUD=true` and any of the six variables missing it exits with `HOVOD_CLOUD=true requires STRIPE_PRICE_BUSINESS, … to be set`. The worker only needs `HOVOD_CLOUD` (it reads plans and usage from the database).

## 3. Stripe setup (once, in the Stripe dashboard)

**Shortcut.** `scripts/setup-stripe.mjs` creates the products, the multi-currency
prices, the portal configuration and the webhook endpoint, then prints the
environment block. It is idempotent (objects are matched on
`metadata.hovod_plan`), so it is safe to re-run.

```bash
STRIPE_SECRET_KEY=sk_test_… APP_URL=https://app.hovod.dev node scripts/setup-stripe.mjs --dry-run
STRIPE_SECRET_KEY=sk_test_… APP_URL=https://app.hovod.dev node scripts/setup-stripe.mjs
# live mode refuses to run without --yes:
STRIPE_SECRET_KEY=sk_live_… APP_URL=https://app.hovod.dev node scripts/setup-stripe.mjs --yes
```

Options: `--currency=usd --also=eur --pro=29 --business=99`. Two things it
cannot do for you: declaring your Stripe Tax registrations, and setting dunning
to *cancel after all retries fail* (§5) — both are dashboard-only.

**Known limitation — plan switching.** The API accepts the `products` list for
`subscription_update` (it rejects unknown ids) but does not store it, so the
portal shows no "Change plan" link. Tick it by hand in the dashboard:
Settings → Billing → Customer portal → *Customers can switch plans*, adding both
products. Hovod itself handles the change correctly once Stripe emits it: the
webhook updates `plan` and the quotas within seconds.

The rest of this section documents what the script does, for anyone configuring
it by hand.


### 3.1 Products and prices

Create two products with one **recurring** price each (monthly, or monthly + yearly if you add more price ids later — only one price per plan is mapped today):

- **Hovod Pro** → copy its price id into `STRIPE_PRICE_PRO`
- **Hovod Business** → `STRIPE_PRICE_BUSINESS`

Tax: enable **Stripe Tax** (Checkout is created with `automatic_tax` and `tax_id_collection`; the billing address is collected). Promotion codes are allowed at Checkout.

### 3.2 Customer portal

Settings → Billing → **Customer portal**. Enable:

- **Subscriptions → Customers can switch plans**: add both prices, proration *on*.
- **Cancel subscriptions**: *at end of billing period* (Hovod keeps the org active until `current_period_end`, then Stripe sends `customer.subscription.deleted`).
- **Payment methods**: allow updating.
- **Invoice history**: on.
- Default return URL: `https://<APP_URL>/settings` (Hovod passes `return_url` explicitly as well).

If the account is **shared with another product**, its default portal configuration belongs to that product and will not offer Hovod's plans. Create a dedicated configuration and put its `bpc_…` id in `STRIPE_PORTAL_CONFIGURATION_ID`; `is_default` cannot be set through the API, so leaving it unset would silently open the wrong portal.

The dashboard's "Manage billing" / "Change plan" buttons both open the portal (`POST /v1/billing/portal`).

### 3.3 Webhook endpoint

Developers → Webhooks → **Add endpoint**: `https://<APP_URL>/v1/billing/webhook`, latest API version, events:

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
invoice.paid
invoice.payment_failed
invoice.payment_action_required
```

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`. The endpoint verifies the signature on the raw body, records every event id in `stripe_events` (`INSERT IGNORE` — a retry of an already-processed event answers `{ received: true, duplicate: true }`), then re-reads the subscription from Stripe. On an internal error it answers **500** and forgets the event id, so Stripe's retry is processed.

Local testing without the Stripe CLI: sign a payload with `stripe.webhooks.generateTestHeaderString({ payload, secret })` — see `apps/api/scripts/test-cloud-integration.mjs`.

### 3.4 Checkout settings

Nothing to configure: Hovod creates each session with `mode: 'subscription'`, the org's customer, `client_reference_id = orgId`, `subscription_data.metadata.orgId`, address + tax id collection, `payment_method_collection: 'always'`, and an idempotency key (`checkout:<orgId>:<plan>:<day>`) so a double click reuses the same session.

## 4. Plans and limits

Defined in `packages/db/src/constants.ts` (`PLAN_LIMITS`):

| | Pro | Business |
|---|---|---|
| Encoding | 500 min / month | 2 000 min / month |
| AI (transcription) | 50 min / month | 500 min / month |
| Storage | 50 GB | 250 GB |
| API keys | 5 | 20 |
| Members (incl. pending invitations) | 3 | 10 |
| API rate limit | 300 req / min | 600 req / min |

Where they are enforced:

- **API, cheap pre-checks** — `POST /v1/assets` and `POST /v1/assets/:id/process` answer `402 { code: 'storage_limit' | 'encoding_limit' }`; API key / invitation creation answer `402 { code: 'api_keys_limit' | 'members_limit' }`.
- **Worker, authoritative** — after probing the source it fails the job with `Monthly encoding quota reached (500 min). Resets on YYYY-MM-01.` when the duration would cross the ceiling; the AI phase is skipped (asset stays ready) with the same kind of message when the AI budget is exhausted.
- **Counters** — `usage_monthly` (UTC `YYYY-MM`, seconds) is written by the worker; storage is `SUM(assets.storage_bytes)` per org (the worker writes source + renditions + thumbnails + AI outputs at job end). `GET /v1/auth/me` and `GET /v1/orgs/:id/usage` expose them.

Months roll over automatically: a new `YYYY-MM` row starts at zero.

## 5. Subscription lifecycle

Stripe is the single source of truth. Every path — Checkout return, webhook, nightly reconcile — calls `syncSubscription(id)` which retrieves the subscription and mirrors it into `organizations` (`plan`, `subscription_status`, `stripe_price_id`, `current_period_end`, `cancel_at_period_end`, `grace_until`, `activated_at`).

| Stripe status | Entitlement | What the org can do |
|---|---|---|
| `active`, `trialing` | `active` | everything |
| `past_due` (first 7 days) | `grace` | everything; dashboard shows "Payment failed — update your card before …" |
| `past_due` after the grace deadline, `unpaid`, `canceled`, `incomplete`, `incomplete_expired`, `paused` | `readonly` | `GET` only: videos keep playing, dashboard read-only, uploads / processing / settings changes answer 402 |
| no subscription yet | `pending` | `GET` only; the dashboard shows the paywall ("Finish setting up your subscription" → `POST /v1/billing/checkout`) |

### Dunning policy

What Hovod does, and what you must configure in Stripe so the two agree:

| Day | Stripe | Hovod | The customer sees |
|-----|--------|-------|-------------------|
| 0 | `invoice.payment_failed`, subscription → `past_due` | `grace_until = now + 7 d`, entitlement `grace`, "payment failed" email to the owner | Full access, a sticky banner with the deadline and a **Manage billing** button |
| 1–6 | Smart Retries (configure 3–4 attempts over ~7 days) | nothing new — one email per transition, not per retry | Same banner |
| 7 | still `past_due` | entitlement → `readonly` | Videos keep playing and the dashboard still renders; uploads, processing and settings changes answer `402` |
| — | `invoice.paid` / back to `active` | `grace_until` cleared, entitlement `active` | Banner gone, no data lost |
| End of retries | your Stripe setting: **cancel the subscription** | `canceled` → `readonly`, "subscription ended" email | Read-only + export; resubscribing from the paywall opens a new Checkout on the same customer |

Set Stripe → Settings → Billing → **Subscriptions and emails**: Smart Retries on, "cancel subscription" when all retries fail, and Stripe's own dunning emails on (Hovod's emails are about access, Stripe's are about the card). Data is retained for **30 days after cancellation** before deletion — say so in your terms, and keep the export path working for that whole window.

**Payment fails** → Stripe retries per your dunning settings; Hovod emails the owner (link to the portal, grace deadline), keeps full access for 7 days (`grace_until = first past_due + 7 d`), then drops to read-only until an `invoice.paid` / `active` sync clears it.

**Cancel** → with "cancel at period end" the org stays `active` (with `cancel_at_period_end = 1`, the dashboard shows "cancels on …") until the period ends; Stripe then deletes the subscription → `canceled` → read-only + "subscription ended" email. Resubscribing from the paywall creates a new Checkout on the same customer.

**Emails** sent by `syncSubscription` (best effort, once per transition): welcome (first activation, also marks the owner's email as verified), payment failed, subscription canceled.

### Reconcile

`apps/api/src/services/billing-reconcile.ts` re-syncs every org with a `stripe_subscription_id` every 24 h (± 1 h jitter, first run 5 min after boot) under a Redis lock (`SET hovod:reconcile NX EX 3600`) so only one replica does it. Orgs that started a Checkout but never activated stay pending (the paywall is their recovery path) and are only counted. Look for `[reconcile] N subscription(s) checked …` in the API log.

## 6. Data model (migration `0004_cloud`)

- `organizations`: `plan`, `subscription_status`, `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `current_period_end`, `cancel_at_period_end`, `grace_until`, `activated_at` (the old `tier` column is migrated — `pro`/`business` → `plan`, `free` → `NULL` — and dropped).
- `users.email_verified_at`, `assets.storage_bytes`.
- `stripe_events` (webhook idempotency), `usage_monthly`, `org_invitations`, `password_resets`.

Self-host installs run the same migration; the columns simply stay `NULL` / `0`.

## 7. Email (Resend)

Cloud mode **requires** a working mail provider: invitations, password resets and the payment-failure notice are how customers keep their access.

1. Create a [Resend](https://resend.com) account and add your sending domain (e.g. `hovod.dev`).
2. Publish the DKIM, SPF and DMARC records Resend gives you and wait for the domain to verify. A `MAIL FROM` subdomain such as `send.hovod.dev` keeps the alignment clean.
3. Create an API key with **Sending access** only → `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to a verified sender, formatted as `Hovod <no-reply@hovod.dev>`. Use an address that accepts replies, or set a reply-to alias you actually read.

| Email | Trigger |
|-------|---------|
| Welcome | first activation of a subscription (also marks the owner's email verified) |
| Invitation | `POST /v1/orgs/:orgId/members/invite` — 7-day link |
| Password reset | `POST /v1/auth/forgot-password` — one-time, 1-hour link |
| Payment failed | first `past_due`, with the grace deadline and a portal link |
| Subscription canceled | subscription deleted at Stripe |

Delivery is best effort and never fails the request that triggered it: `services/email.ts` logs and returns `{ sent: false }` when Resend is unreachable. Watch the Resend dashboard for bounces, and keep an eye on the API log for `email send failed`.

Quota emails (80 % / 100 % of a plan limit) are **not** implemented yet — customers discover a quota through the 402 and the usage bars. Monitor `usage_monthly` yourself until that lands.

## 8. Storage and CDN (Cloudflare R2)

Streaming is unmetered on Hovod Cloud because R2 charges nothing for egress. The setup:

1. **Bucket** — create `hovod-cloud` in R2 with **jurisdiction EU** (it cannot be changed later). Note the account id: the S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
2. **Credentials** — an R2 API token scoped to that bucket, Object Read & Write → `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`. `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`.
3. **`S3_PUBLIC_ACL=false`** — **mandatory**. R2 has no per-object ACLs, so the worker's `ACL: public-read` would fail every upload. Public read is granted at the bucket level instead (step 4).
4. **Custom domain** — attach `cdn.hovod.dev` to the bucket (R2 → Settings → Public access → Custom domain). That makes the bucket publicly readable through Cloudflare only, and gives you cache control. Set `S3_PUBLIC_BASE_URL=https://cdn.hovod.dev`.
5. **Cache rules** on `cdn.hovod.dev`:

   | Path | Edge TTL | Why |
   |------|----------|-----|
   | `*/segment*.ts`, `*.m4s`, `*.jpg`, `*.webp` | 1 year, immutable | segments and sprites never change for a given asset |
   | `*/master.m3u8`, `*/index.m3u8` | 60 s | short so a re-encode is picked up quickly |
   | `*/ai/*` | 5 min | transcripts and chapters are editable |

   The worker already sets matching `Content-Type` and `Cache-Control` headers per extension; the rules are belt and braces.
6. **CORS** on the bucket: allow `GET`, `HEAD` from your app origin and `*` for the embeddable player (segments are fetched by hls.js from arbitrary parent pages). Allow `PUT` from `APP_URL` only — that is the presigned upload path.
7. **Lifecycle** — abort incomplete multipart uploads after 7 days, so an abandoned browser upload does not accumulate parts forever.
8. **Sovereign alternative**: Scaleway Object Storage `fr-par` works the same way (`S3_FORCE_PATH_STYLE=true`, a public bucket policy on `playback/`, `S3_PUBLIC_ACL=false`) but egress is billed — price your plans accordingly before choosing it.

Uploads go browser → R2 directly (presigned single `PUT` or multipart), so `S3_PUBLIC_ENDPOINT` must be the endpoint the browser can reach; leave it unset when it equals `S3_ENDPOINT`.

## 9. DNS and hosting

| Record | Points at | Purpose |
|--------|-----------|---------|
| `app.hovod.dev` | the API load balancer / reverse proxy | dashboard + API. This is `APP_URL` |
| `cloud.hovod.dev` | CNAME → `app.hovod.dev` | alias kept for older links |
| `cdn.hovod.dev` | R2 custom domain | HLS, posters, sprites, AI outputs |
| `hovod.dev`, `www` | the marketing site | separate repository |
| DKIM / SPF / DMARC | Resend | transactional email |

Deployment shape (no Kubernetes):

- `HOVOD_ROLE=api`, 2+ replicas behind the proxy, all sharing the same `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL` and S3 variables. TLS terminates at the proxy; raise its body-size limit for direct uploads (or rely on presigned uploads, which bypass it).
- `HOVOD_ROLE=worker`, on a CPU-heavy machine, scaled with the encoding backlog. Give it disk: `WORK_DIR` needs roughly 3× the largest source.
- Managed MySQL 8.4 and Redis, or containers with daily backups shipped to R2.
- Only one process runs migrations at a time — the runner takes `GET_LOCK('hovod_migrations')`, so rolling deploys are safe.
- Point uptime monitoring at `GET /health/ready` (it answers 503 when the database is down) and alert on queue depth and worker disk usage.

## 10. Go-live checklist

Run through this in Stripe **test mode** first, then repeat the Stripe half in live mode.

**Configuration**
- [ ] `HOVOD_CLOUD=true` on the API **and** every worker
- [ ] `APP_URL=https://app.hovod.dev`, `CORS_ORIGIN` set to your real origins (never `*` in cloud)
- [ ] `JWT_SECRET` and `API_KEY_SECRET` generated (`openssl rand -hex 32`) and identical on every API replica
- [ ] `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, `RESEND_API_KEY`, `EMAIL_FROM` all set — the API refuses to boot otherwise
- [ ] `S3_PUBLIC_ACL=false` with the R2 custom domain live and cache rules applied
- [ ] `REGISTRATION_ENABLED=true` (cloud signup goes through Checkout anyway) and `REGISTRATION_ALLOWED_DOMAINS` unset

**Stripe**
- [ ] Pro and Business products, one recurring price each, in every currency you advertise
- [ ] Stripe Tax enabled, tax registrations declared, `automatic_tax` verified on a real Checkout
- [ ] Customer portal: plan switching (both prices, proration on), cancel at period end, payment-method update, invoice history, return URL `https://app.hovod.dev/settings`
- [ ] Webhook endpoint `https://app.hovod.dev/v1/billing/webhook` with the nine events of §3.3, signing secret deployed
- [ ] Dunning: Smart Retries on, "cancel after all retries fail", Stripe emails on
- [ ] Terms of service and refund policy linked from Checkout

**Verify end to end (test mode)**
- [ ] Signup → Checkout → return → the dashboard is usable within a couple of seconds (`POST /v1/billing/sync` beats the webhook)
- [ ] Upload a 10-bit / HDR clip, watch it transcode, play the embed on a **third-party** page, check analytics appear and the owner preview is not counted
- [ ] Invite a teammate, accept from a different browser; request a password reset and complete it
- [ ] Change plan in the portal → `plan` and `limits` change without signing out
- [ ] Force `past_due` (a failing test card) → grace banner and email; move `grace_until` into the past → read-only and 402 on upload
- [ ] Cancel → access until `current_period_end`, then read-only; resubscribe from the paywall
- [ ] Replay a webhook from the Stripe dashboard → `{ received: true, duplicate: true }`
- [ ] Exceed a quota deliberately → clear 402 with the right `code`, and the worker's message names the reset date

**Operations**
- [ ] Database backup runs and a **restore has been tested** on a scratch instance
- [ ] Uptime check on `/health/ready`, error alerting, queue-depth and disk alerts
- [ ] `[reconcile] N subscription(s) checked` appears in the API log within a day
- [ ] A support address that reaches a human, and a documented "delete my account and data" path

## 11. Operations cheat sheet

- **Rotate the webhook secret**: create a new endpoint (or roll the secret), update `STRIPE_WEBHOOK_SECRET`, restart the API.
- **Force a re-sync of one org**: from a Stripe dashboard, "Resend" any subscription event of that customer; or wait for the nightly reconcile.
- **Password reset without email**: `node apps/api/dist/cli.js reset-password <email>` prints a one-time link (also `npm run hovod-cli -w @hovod/api -- reset-password <email>`).
- **A user cannot upload**: check `GET /v1/auth/me` → `org.entitlement` and `usage` vs `limits`; 402 responses carry a `code` telling which limit was hit.
- **Tests**: `npm test -w @hovod/db` (migration 0004 fresh + tier upgrade, quota arithmetic) and `npm test -w @hovod/api` (entitlement state machine; with `HOVOD_TEST_DATABASE_URL` also `syncSubscription` against a fake Stripe client; with `HOVOD_TEST_STACK=1` the full self-host / cloud boot including the signed-webhook dedupe).
