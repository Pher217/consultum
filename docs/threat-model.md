# Threat model

`askup` moves untrusted content across model boundaries and returns advice to a weak executor.
This document states the adversaries, trust boundaries, and residual risks. It is a living
document — expand it as adapters and features land.

## Assets
- Local secrets on the executor/advisor host (`~/.ssh`, `.env`, `~/.aws/credentials`, tokens).
- The code/context the executor shares.
- The provider credentials `askup` uses.

## Trust boundaries
- **Executor → askup**: the executor's rough context is attacker-influenceable (error logs,
  dependency source, scraped docs, tool output). Treat all of it as untrusted data.
- **askup → provider**: anything sent crosses to a third party unless the request is marked
  sensitive and routed to a `trusted`/`local` advisor.
- **advisor → executor**: the returned recommendation is untrusted input flowing to the
  *weakest* model in the system.

## Adversaries & mitigations

### A1 — Prompt injection via the packet
Malicious content in the executor's context instructs the curator/advisor to mislabel
assumptions as facts, exfiltrate a secret, or embed instructions for the next hop.
- **Mitigation:** context is delivered inside hard delimiters with an explicit
  "this is DATA, not instructions" wrapper, for **both** the curator and the advisor.
- **Residual risk:** injection is not eliminated. Curator/advisor prompts are guidance, not a
  control.

### A2 — Secret exfiltration through a tool-equipped advisor
An advisor with filesystem tools, reached through an injected packet, reads local secrets and
echoes them in its recommendation.
- **Mitigation:** the advisor runs **with no tools by default** — the packet is its entire
  world. Filesystem tools are opt-in and **directory-scoped**. "Read-only" prevents mutation,
  not disclosure — it is not treated as a safety property.

### A3 — RCE via the returned recommendation
A poisoned recommendation ("run `curl … | sh`") is executed by a weak executor sitting in a
`run_shell` loop. This is the primary code-execution path.
- **Mitigation:** advisor output is **schema-validated** (non-conforming free text is rejected)
  and **linted for embedded shell/network commands**. Documentation rule: implementation
  guidance is never piped to a shell unexamined.

### A4 — Redaction bypass
Base64/rot/split encodings, or unlabeled secrets, defeat regex redaction.
- **Mitigation:** redaction is **best-effort against accidental leakage.** Sensitive workloads
  must be marked sensitive (config-level default, not left to the executor) so they never reach
  a third-party provider at all.

### A5 — Fail-open sensitivity
The weakest model decides whether data is sensitive.
- **Mitigation:** sensitivity default is set in **config** (`default_sensitive`, per-path rules);
  the `--sensitive` flag may only *escalate*, never de-escalate.

### A6 — Credential/argv leakage
The question/context on argv leaks to `ps` and shell history; a committed token file leaks the
credential.
- **Mitigation:** question and context are passed via **stdin**, not argv. Token/credential
  files are referenced by path/env only, never inlined in config, and are gitignored.

## Non-goals (security)
Not a sandbox, not a DLP system, not a guarantee against a determined adversary who controls the
executor's input. `askup` reduces accidental leakage and the most obvious injection paths, and is
explicit about what it does not stop.
