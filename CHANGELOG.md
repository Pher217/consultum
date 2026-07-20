# Changelog

All notable changes to askup are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [Unreleased]

### Added
- **Cross-engine setup ease** — keychain-free auth (`token_file`/`token_env` for CLI adapters injected
  into the subprocess env; `api_key_file` for HTTP adapters) via a shared credential resolver with
  safety gates (single line, ≤4 KB, POSIX perm hard-fail, config-relative paths).
- `askup doctor` **credential-free diagnostics** — classifies `ok | not-authed | egress-blocked |
  dns-fail | not-on-path`, hints at a blocked sandbox, and exits non-zero when no advisor is usable.
- `askup init --sandbox` — HTTP-only preset for callers inside a restricted sandbox, plus
  `docs/sandboxed-callers.md`.

### Security
- Adapter stderr / HTTP error bodies are redacted before entering error messages.
- Threat model names the config file as trusted input (A7), with the `base_url` exfil residual stated.

## [0.1.0] — 2026-07-19

First working release. Provider-agnostic advisory-escalation channel for delegated AI workers.

### Added
- `consult` (single advisor + optional curator, off by default, with a deterministic template
  fallback) · ordered advisor fallback chain with retry-once on malformed output.
- Four provider adapters: `anthropic-cli` (+ thin `anthropic-api`), `openai`/`openai-compatible`,
  `ollama`, `codex-cli` (with the `codex exec -` stdin fix).
- CLI (`consult` / `init` / `doctor` / `config`, question + context via stdin), library
  (`consult`, `askupTool`), and a tool-loop shim (`consult_advisor` schema + Ollama/OpenAI examples).
- One config file (role→model with a user-assigned `local | trusted | untrusted` trust class);
  ≤15-line working example.
- Machine-readable exit codes, token/cost provenance, Windows support matrix.

### Security
- Advisor invoked **no-tools / request-shaped by default**; filesystem tools opt-in and
  directory-scoped (read-only only).
- Fail-closed sensitivity (config-level `default_sensitive` + per-path; `--sensitive` escalate-only);
  a sensitive request with no trusted/local advisor **refuses**, never downgrades.
- Best-effort secret redaction before every cross-model send (10-case regression).
- Advisor output schema-validated and linted for embedded shell/network commands.
- **No telemetry.**

[Unreleased]: https://github.com/Pher217/askup/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Pher217/askup/releases/tag/v0.1.0
