# Changelog

All notable changes to consultum are documented here. Format loosely follows
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
  (`consult`, `consultumTool`), and a tool-loop shim (`consult_advisor` schema + Ollama/OpenAI examples).
- One config file (role→model with a user-assigned `local | trusted | untrusted` trust class);
  ≤15-line working example.
- **Keychain-free auth** — `token_file`/`token_env` (CLI adapters, injected into the subprocess env)
  and `api_key_file` (HTTP adapters), via a shared credential resolver with safety gates (single
  line, ≤4 KB, POSIX perm hard-fail, config-relative paths).
- `consultum doctor` **credential-free diagnostics** — classifies `ok | not-authed | egress-blocked |
  dns-fail | not-on-path`, hints at a blocked sandbox, exits non-zero when no advisor is usable.
- `consultum init --sandbox` — HTTP-only preset for callers inside a restricted sandbox, plus
  `docs/sandboxed-callers.md`.
- **Escalation panel** — `--panel` (or automatically on a low-confidence answer) asks every model
  in `roles.panel` the same question concurrently and returns each view. An optional `reconciler`
  synthesizes them and is instructed to name material dissent; without one, `agreement` stays
  `unassessed` — consultum does not guess whether two prose answers agree. Panel size is capped, and a
  panel whose members all fail is reported as not convened rather than as an empty consensus.
- `consultum init --interactive` — a terminal wizard that fills in the config instead of leaving a
  template to hand-edit. Terminal, not a localhost web UI: consultum's primary caller runs headless,
  in a sandbox or in CI.
- `StructuredRecommendation` carries `schemaVersion`, and `provenance.curationNote` reports when
  curation was requested but skipped or failed.
- Published TypeScript declarations (`types/index.d.ts`).
- Machine-readable exit codes, token/cost provenance, Windows support matrix.

### Fixed (pre-publish hardening)
- Unknown CLI flags, unknown JSON-stdin keys, and unknown config keys (top-level, `policy`, `roles`, and per-model) are now rejected as usage errors (exit 10) instead of being silently ignored — a typo like `--sensitve` previously proceeded as a normal non-sensitive consult.
- `doctor` now reports `ok-unverified` (not a bare `ok`) for the HTTP adapters (`openai` / `anthropic-api` / `openai-compatible`) — reachability and credential presence are checked, but the model id is not verified.
- Malformed JSON on stdin is now a usage error (exit 10) raised before any provider call, instead of being silently treated as a plain-text question and billed.
- Oversized stdin (>1 MB) now exits `10` (usage) and honours `--json`, instead of exiting `1` with a plain-text message outside the documented exit-code contract.
- `init` no longer scaffolds an invalid hardcoded model id: the Codex entry uses the model from `~/.codex/config.toml` (or is left commented when unknown), and `config.example.yaml` ships the correct `claude-opus-4-8` id.
- `init` picks a genuinely general-purpose local Ollama tag using the `/api/tags` capabilities array (skips embedding models, ranks down vision-only and domain-specific models) instead of just the largest tag.
- `--task-id` consult-budget state is now read fail-closed (a corrupt file errors instead of silently resetting the budget), written atomically, and guarded by a lock so concurrent workers sharing a task id cannot exceed the cap.

### Limits
- Input is capped at 1 MB (stdin) and subprocess output at 4 MB; a panel is capped at 5 members.
  consultum spends real money on hosted providers, so unbounded input and unbounded fan-out are both
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

[0.1.0]: https://github.com/Pher217/consultum/releases/tag/v0.1.0
