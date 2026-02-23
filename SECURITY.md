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
| 0.1.x   | Yes       |

## Security Considerations

Hovod is currently in early development (MVP). Be aware of the following:

- **No built-in authentication** — the API is open by default. Deploy behind a reverse proxy with authentication for production use.
- **CORS is set to `*` by default** — restrict `CORS_ORIGIN` in production.
- **Source URL imports** accept any URL — consider network-level restrictions to prevent SSRF in production environments.
