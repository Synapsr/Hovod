# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Hovod, please report it responsibly.

**Do not open a public issue for security vulnerabilities.**

Instead, please email the maintainers or use [GitHub's private vulnerability reporting](https://github.com/Synapsr/Hovod/security/advisories/new).

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical vulnerabilities.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes — bug fixes and security fixes |
| 0.2.x   | Security fixes only |
| 0.1.x   | No — upgrade to 1.0.x |

Only the latest patch release of a supported line receives fixes. See [Upgrading from 0.x](CHANGELOG.md#upgrading-from-0x) before moving from a 0.x install.

## Security Considerations

- **Authentication** — every `/v1/*` route (except public playback, analytics ingestion, login/signup and the Stripe webhook) requires a JWT (dashboard login) or an `X-Api-Key`. Registration is open by default: set `REGISTRATION_ENABLED=false` or `REGISTRATION_ALLOWED_DOMAINS` on a public instance.
- **Secrets** — the all-in-one image generates `JWT_SECRET` and the embedded MariaDB root password on first boot and persists them in `/data/.hovod-secrets` (mode 600). Back up that file with the volume; rotating `JWT_SECRET` invalidates every session and every API key.
- **CORS is set to `*` by default** — restrict `CORS_ORIGIN` in production.
- **API keys** are peppered with `API_KEY_SECRET` (falling back to `JWT_SECRET`). Set it explicitly so the JWT secret can be rotated without invalidating every key; changing `API_KEY_SECRET` itself invalidates all existing keys. Keys can be scoped to `read` and given an expiry, and are revoked automatically when the member who created them is removed.
- **Sessions** are revocable: access tokens live 24 hours and carry `users.token_version`, so changing or resetting a password — or `POST /v1/auth/logout-all` — invalidates every token issued earlier.
- **Source URL imports and organization webhooks** are guarded against SSRF (http(s) only, no credentials in the URL, ports 80/443/8080/8443, every resolved address must be public, re-checked on each redirect). Network-level restrictions remain a sensible second layer.
- **Playback is public** — anyone who knows a playback ID (16 random characters) can watch the video. Playback ids are unlisted, not access-controlled: private videos and signed playback URLs are on the roadmap.
- **The embeddable player is meant to be framed**: `frame-ancestors *` applies to `/embed/*` and `/watch/*` only; the dashboard keeps a restrictive Content-Security-Policy.
- **Cloud mode** (`HOVOD_CLOUD=true`) verifies every Stripe webhook signature against the raw body and deduplicates event ids; never expose the webhook route without `STRIPE_WEBHOOK_SECRET` set.
