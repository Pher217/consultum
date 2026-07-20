# Changelog

All notable changes to askup are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.1.0] — 2026-07-20

First release. Provider-agnostic advisory-escalation channel for delegated AI workers: when a cheap
worker gets stuck, it escalates a curated, secret-redacted problem to a stronger read-only advisor.

### Added
- `consult` (single advisor + optional curator, off by default, with a deterministic template
  fallback) · ordered advisor fallback chain with retry-once on malformed output.
- Four provider adapters: `anthropic-cli` (+ thin `anthropic-api`), `openai`/`openai-compatible`,
  `ollama`, `codex-cli` (with the `codex exec -` stdin fix).
- CLI (`consult` / `init` / `doctor` / `config`, question + context via stdin), library
  (`consult`, `askupTool`), and a tool-loop shim (`consult_advisor` schema + Ollama/OpenAI examples).
- One config file (role→model with a user-assigned `local | trusted | untrusted` trust class);
  ≤15-line working example.
- **Keychain-free auth** — `token_file`/`token_env` (CLI adapters, injected into the subprocess env)
  and `api_key_file` (HTTP adapters), via a shared credential resolver with safety gates (single
  line, ≤4 KB, POSIX perm hard-fail, config-relative paths).
- `askup doctor` **credential-free diagnostics** — classifies `ok | not-authed | egress-blocked |
  dns-fail | not-on-path`, hints at a blocked sandbox, exits non-zero when no advisor is usable.
- `askup init --sandbox` — HTTP-only preset for callers inside a restricted sandbox, plus
  `docs/sandboxed-callers.md`.
- **Escalation panel** — `--panel` (or automatically on a low-confidence answer) asks every model
  in `roles.panel` the same question concurrently and returns each view. An optional `reconciler`
  synthesizes them and is instructed to name material dissent; without one, `agreement` stays
  `unassessed` — askup does not guess whether two prose answers agree. Panel size is capped, and a
  panel whose members all fail is reported as not convened rather than as an empty consensus.
- `askup init --interactive` — a terminal wizard that fills in the config instead of leaving a
  template to hand-edit. Terminal, not a localhost web UI: askup's primary caller runs headless,
  in a sandbox or in CI.
- `StructuredRecommendation` carries `schemaVersion`, and `provenance.curationNote` reports when
  curation was requested but skipped or failed.
- Published TypeScript declarations (`types/index.d.ts`).
- Machine-readable exit codes, token/cost provenance, Windows support matrix.

### Limits
- Input is capped at 1 MB (stdin) and subprocess output at 4 MB; a panel is capped at 5 members.
  askup spends real money on hosted providers, so unbounded input and unbounded fan-out are both
  treated as cost/DoS surface, not just robustness.

### Security
- Advisor invoked **no-tools / request-shaped by default**; filesystem tools opt-in and
  directory-scoped (read-only only).
- Fail-closed sensitivity (config-level `default_sensitive` + per-path; `--sensitive` escalate-only);
  a sensitive request with no trusted/local advisor **refuses**, never downgrades.
- Best-effort secret redaction before every cross-model send (10-case regression); adapter
  stderr / HTTP error bodies redacted before entering error messages.
- Advisor output schema-validated and linted for embedded shell/network commands.
- Threat model names the config file as trusted input (A7).
- **No telemetry.**

[0.1.0]: https://github.com/Pher217/askup/releases/tag/v0.1.0
