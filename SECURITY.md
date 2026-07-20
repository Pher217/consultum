# Security Policy

`askup` sends your code's *context* to model providers. Treat it accordingly.

## Reporting a vulnerability

Please open a private security advisory on GitHub (Security → Report a vulnerability).
Do not open a public issue for security problems.

## What askup does and does not protect

See [`docs/threat-model.md`](docs/threat-model.md) for the full model. In short:

- Secrets are redacted before any cross-model send — **best-effort against accidental
  leakage, not adversarial encoding.** Do not rely on it to scrub deliberately-hidden secrets.
- The advisor runs **with no tools by default**; filesystem access is opt-in and directory-scoped.
- The advisor's returned recommendation is **untrusted input** — never pipe its implementation
  guidance to a shell unexamined.
- No telemetry. `askup` communicates only with the model providers you configure.
