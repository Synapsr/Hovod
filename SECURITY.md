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
| 0.2.x   | Yes       |
| 0.1.x   | Upgrade to 0.2.x |

## Security Considerations

- **Authentication** — every `/v1/*` route (except public playback, analytics ingestion, login/signup and the Stripe webhook) requires a JWT (dashboard login) or an `X-Api-Key`. Registration is open by default: set `REGISTRATION_ENABLED=false` or `REGISTRATION_ALLOWED_DOMAINS` on a public instance.
- **Secrets** — the all-in-one image generates `JWT_SECRET` and the embedded MariaDB root password on first boot and persists them in `/data/.hovod-secrets` (mode 600). Back up that file with the volume; rotating `JWT_SECRET` invalidates every session and every API key.
- **CORS is set to `*` by default** — restrict `CORS_ORIGIN` in production.
- **Source URL imports** accept any public URL — consider network-level restrictions to prevent SSRF in production environments.
- **Playback is public** — anyone who knows a playback ID (16 random characters) can watch the video. Private/password-protected playback is on the roadmap.
