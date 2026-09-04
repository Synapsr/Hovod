# Hovod Cloud — operator guide

`HOVOD_CLOUD=true` turns a Hovod deployment into a **paid-only** service: signup starts a Stripe Checkout, every organization needs an active subscription, and plan limits are enforced. This is how [hovod.dev](https://hovod.dev) runs. A self-hosted install never needs any of this — leave `HOVOD_CLOUD` unset and Hovod stays unlimited and never contacts Stripe.

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
| `RESEND_API_KEY`, `EMAIL_FROM` | [Resend](https://resend.com) key + verified sender (`Hovod <no-reply@hovod.dev>`) |
| `REDIS_URL` | already required — also used for the reconcile lock |

The API validates the whole group at boot: with `HOVOD_CLOUD=true` and any of the six variables missing it exits with `HOVOD_CLOUD=true requires STRIPE_PRICE_BUSINESS, … to be set`. The worker only needs `HOVOD_CLOUD` (it reads plans and usage from the database).

## 3. Stripe setup (once, in the Stripe dashboard)

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

## 7. Operations cheat sheet

- **Rotate the webhook secret**: create a new endpoint (or roll the secret), update `STRIPE_WEBHOOK_SECRET`, restart the API.
- **Force a re-sync of one org**: from a Stripe dashboard, "Resend" any subscription event of that customer; or wait for the nightly reconcile.
- **Password reset without email**: `node apps/api/dist/cli.js reset-password <email>` prints a one-time link (also `npm run hovod-cli -w @hovod/api -- reset-password <email>`).
- **A user cannot upload**: check `GET /v1/auth/me` → `org.entitlement` and `usage` vs `limits`; 402 responses carry a `code` telling which limit was hit.
- **Tests**: `npm test -w @hovod/db` (migration 0004 fresh + tier upgrade, quota arithmetic) and `npm test -w @hovod/api` (entitlement state machine; with `HOVOD_TEST_DATABASE_URL` also `syncSubscription` against a fake Stripe client; with `HOVOD_TEST_STACK=1` the full self-host / cloud boot including the signed-webhook dedupe).
