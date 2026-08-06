# Threat model

`consultum` moves untrusted content across model boundaries and returns advice to a weak executor.
This document states the adversaries, trust boundaries, and residual risks. It is a living
document — expand it as adapters and features land.

## Assets
- Local secrets on the executor/advisor host (`~/.ssh`, `.env`, `~/.aws/credentials`, tokens).
- The code/context the executor shares.
- The provider credentials `consultum` uses.

## Trust boundaries
- **Executor → consultum**: the executor's rough context is attacker-influenceable (error logs,
  dependency source, scraped docs, tool output). Treat all of it as untrusted data.
- **consultum → provider**: anything sent crosses to a third party unless the request is marked
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
  world. Filesystem tools are opt-in, **directory-scoped**, and restricted to read-only tools
  (`Read`/`Grep`/`Glob`); shell/network tools are rejected by config validation. "Read-only" prevents
  mutation, not disclosure — it is not treated as a safety property.
- **Adapter caveat:** `codex-cli` (`codex exec -s read-only`) is a **read-capable agent**, not a
  no-tools advisor — it can autonomously read files in its working directory. Do not place it first
  in an untrusted advisor chain, and never use it for sensitive data. Prefer the `openai` adapter
  (genuine request-shaped, no tools) for an OpenAI advisor. Even the opt-in `anthropic-cli` tools use
  `--add-dir`, which *adds* directories without removing the process's own cwd — run consultum from a
  directory with no secrets when enabling tools.

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

### A7 — The config file is trusted input
`consultum` reads its config from the first of `$CONSULTUM_CONFIG`, `./consultum.{yaml,yml,json}`,
`$XDG_CONFIG_HOME/consultum/config.yaml`, `~/.consultum.*` — so a config in the **current directory wins over
the user's home config**. A model entry can point at an arbitrary `base_url` and reference a credential
by env-var name (and, where enabled, by file path). A caller that can **write the config consultum will
discover** — e.g. an attacker who can drop `./consultum.yaml` into a worker-writable working directory — can
therefore make consultum send a referenced credential (an env-var key today; a file-based key where
`token_file`/`api_key_file` is enabled) as an `Authorization: Bearer` header to a host of their choosing.
`trust:` is self-assigned in that config, so `--sensitive` does not block it.
- **Mitigation:** the config file is **trusted input**, on par with the code consultum runs. Do **not** run
  consultum with a config discoverable from a directory an untrusted worker can write to — pin `--config` /
  `$CONSULTUM_CONFIG` to a path **outside the workspace** (see `docs/sandboxed-callers.md`). File-based
  credentials additionally pass a shape gate (single line, size-capped, POSIX perm-checked) so a config
  cannot turn an arbitrary file (an SSH key, `.env`) into an exfiltrated Bearer header.
- **Residual:** an attacker who controls both the config *and* a reachable `base_url` can still
  exfiltrate an env-var credential — inherent to a tool that sends credentials to configured endpoints.
  The control is "don't let untrusted parties write your config," stated plainly here.

### A8 — The human inbox (`contrib/inbox`): unattended agent, asynchronous human answer
`contrib/inbox` lets an agent `ask` a question and continue, then `check`/`wait` for a human's
`answer` later, with no live session on either end for the request/answer path itself. That gap
between ask and answer is new attack surface `consult`'s synchronous, single-process model
doesn't have.
- **Redaction-bypass-by-outage, not just by encoding (extends A4).** `ask` resolves
  `redactSecrets` by walking from the `consultum` binary found on `PATH`
  (`command -v consultum` → `fs.realpathSync` → package root → `src/redact.js`). Any hop
  failing — `consultum` not installed, a broken symlink, a moved `src/redact.js` — must not
  silently produce an unredacted `question.md`. A control that no-ops under its own failure is
  worse than no control, because callers stop checking for it.
  - **Mitigation:** `ask` resolves the redactor **before any filesystem mutation** and hard-fails
    (no `open/<id>/` directory created at all) if resolution fails at any step.
    `test/inbox-channel.test.mjs` runs `ask` with `consultum` absent from `PATH` and asserts both
    a non-zero exit and that `open/` does not exist under the root at all.
  - **PATH is trusted input, and is now verified, not merely followed (closes a real gap).**
    Resolving by walking from whatever `consultum` happens to be first on `PATH` is only safe if
    what's found there is actually the `consultum` package — a fake `<dir>/bin/consultum` earlier
    on `PATH` (or a fake `node`) could otherwise point the walk at an attacker-chosen
    `src/redact.js` that writes UNREDACTED content while still recording `"redacted": true"`,
    silently and with no loud failure anywhere. `resolve_redact_js` now requires the resolved
    package root's `package.json` to have `"name": "consultum"` and requires the resolved module
    to export a callable `redactSecrets`, hard-failing (no directory created) if either check
    fails. `test/inbox-channel.test.mjs` builds a fake package with a working redactor under the
    wrong name and asserts `ask` still refuses it.
- **An unsandboxed, same-uid agent forging its own unblock is the real residual threat here
  (primary — not a forged `meta.json` field).** Nothing at the OS level distinguishes a human
  typing `inbox.sh answer` from an agent that has filesystem access to the inbox root doing the
  same thing. An unsandboxed worker that hits an `ask`/`wait` gate it doesn't like can simply
  write its own `answer.md` and unblock itself — no forged field required, because `answer.md`
  *is* the source of truth, and that's exactly what an agent with write access to it can forge.
  - **Mitigation:** for the vigil path — the main intended use of this channel — nothing
    automatically consumes an answer to resume work. There is no unhalt/resume operation that
    reads `answer.md` and acts on it; a forged answer just sits there, inert, until a human
    reviews the inbox (`list`/`show`) at the next natural checkpoint (e.g. morning review), where
    a forged answer to a question the human never actually saw is visible and out of place.
    `answer` additionally refuses to overwrite an existing `answer.md` (exit `10`), so once a
    forgery is spotted it blocks the legitimate human answer rather than silently coexisting with
    it — forcing a `close`+`ask` cycle that surfaces the conflict. Sandboxed callers (a properly
    scoped worker) cannot reach the inbox root at all.
  - **Honest residual:** a same-uid, unsandboxed worker that calls `wait` directly — rather than
    going through a review gate that actually consumes the answer — CAN forge its own unblock.
    There is no cryptographic answer authentication in this tool. **Do not route
    agent-must-not-decide questions through `wait` in an unsandboxed context**; treat `wait` as
    convenience for a trusted human loop, not a security boundary against the very agent it's
    gating.
- **A forged `answered` mirror is a related but secondary concern (A5's sibling for a file-based
  mirror) — and as of this revision, moot by construction.** `meta.json` no longer carries an
  `answered` field at all (it was written `false` at ask time and never flipped, so it was simply
  stale information sitting next to the question — removed rather than kept in sync, per "one
  fact, one place"). Even before removal, every code path that decides "is this answered" —
  `check`, `wait` — tested `[ -f answer.md ]` directly and never read `meta.json`'s `answered`
  field, so a hand-forged `meta.json` claiming `"answered": true` with no `answer.md` present
  still reported pending (exit `20`); a test still asserts this for a hand-added copy of that
  field.
- **A colliding channel root deletes a populated inbox (operational, not adversarial, but the
  blast radius is real data loss).** `contrib/pair`'s `close <topic>` (no `--force`) decides a
  channel is safe to delete by counting `request-*.md` files directly under the topic directory.
  The inbox uses a different layout (`open/<id>/question.md`); if the inbox root were nested
  under pair's root, `pair.sh close inbox` would see zero `request-*.md` files, conclude nothing
  is open, and `rm -rf` a populated inbox with no `--force` needed. Reproduced live.
  - **Mitigation:** the inbox's default root (`~/.claude/inbox`) is a sibling of, not nested
    under, pair's root (`~/.claude/consult`) — enforced by convention and asserted by a test
    (`test/inbox-channel.test.mjs`) that the default root does not contain `/consult/`.
- **A hardcoded second copy of the root default drifts (operational).** A caller in another repo
  that hardcodes `~/.claude/inbox` instead of asking this tool loses sync the moment the default
  changes here, and then polls the wrong directory forever, reading "still pending" against a
  question a human already answered.
  - **Mitigation:** `inbox.sh root` is the single point where the default is computed
    (`$CONSULTUM_INBOX` if set, else `~/.claude/inbox`); it is a pure, side-effect-free query,
    documented in `contrib/inbox/SKILL.md` as the required way for an external caller to resolve
    the root rather than hardcoding it.
- **Argv/traversal (same class as A6, applied to this channel's own inputs).** `--slug` and any
  user-supplied id are attacker-reachable strings (an agent could be tricked into passing a
  crafted slug). An unvalidated slug like `../../etc/evil` could write outside the inbox root.
  - **Mitigation:** ids and slugs are validated against a strict `[A-Za-z0-9_-]` charset before
    any directory is touched; `/` and `.` are rejected outright. Bodies are stdin/`--file` only,
    per A6.

## Controls in code (each adversary maps to a specific, tested control)

| Adversary | Control | Where |
|---|---|---|
| A1 injection | Context wrapped in nonce-tagged "this is DATA, not instructions" delimiters, both hops | `src/prompts.js` (`wrapUntrusted`), used by `curator.js` + `consult.js` |
| A2 secret exfil via tools | Advisors invoked with **no tools by default**; tools opt-in AND directory-scoped | every `src/providers/*.js`; `config.js` refuses `allow` without `dirs`; asserted in `test/providers.test.js` |
| A3 RCE via recommendation | Advisor output schema-validated (parse contract) + linted for shell/network commands | `src/recommendation.js`; asserted in `test/recommendation.test.js` |
| A4 redaction bypass | Redact twice (raw input + curated output); sensitive routing keeps third parties out entirely | `src/redact.js` (10-case regression), `src/consult.js` |
| A5 fail-open sensitivity | Sensitivity is config-level (`default_sensitive` + per-path); `--sensitive` only escalates | `src/config.js` (`isSensitive`); refusal in `consult.js`; asserted in `test/consult.test.js` |
| A6 argv/cred leak | Question + context via stdin (CLI + `runWithStdin`); every CLI adapter feeds its prompt on stdin, incl. `codex exec -`; tokens by path/env, gitignored; adapter stderr redacted before it enters an error message | `bin/consultum.js`, `src/run.js`, `src/providers/*`, `src/redact.js` (`redactedTail`) |
| A7 config-as-trust-boundary | File-based credentials pass a shape gate (single line, ≤4 KB) + POSIX perm hard-fail; docs pin the config outside any worker-writable dir | `src/credential.js`; `docs/threat-model.md`, `docs/sandboxed-callers.md` |

Fail-closed refusal (a sensitive request with no trusted/local advisor) returns exit code `11`
(`refused-by-policy`) and never downgrades to a third party — see `test/consult.test.js`.

## Non-goals (security)
Not a sandbox, not a DLP system, not a guarantee against a determined adversary who controls the
executor's input. `consultum` reduces accidental leakage and the most obvious injection paths, and is
explicit about what it does not stop.
