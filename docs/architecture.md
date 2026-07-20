# Architecture

`askup` is a small library + CLI (Node, ESM). It does one thing: **controlled escalation from a
weaker executor to a stronger advisor**, with optional context curation and safety controls.

## Flow

```
Executor (any model/engine, stuck)
  -> askup consult (question + rough context, {sensitivity})
       1. redact secrets            (local, deterministic, best-effort)
       2. curate (optional)         (high-context cheap model -> structured packet)
                                     or a deterministic template builder if no curator configured
       3. redact again              (curated output re-scanned)
       4. advise (no tools)         (strong model, request-shaped; packet is its whole world)
            └─ if advisor down/stalled -> next in the advisor fallback chain
       5. validate output           (schema; lint for embedded shell/network commands)
       6. return StructuredRecommendation
  -> Executor evaluates, implements the smallest safe fix, verifies
```

Reliability comes first from an **ordered availability fallback chain** (first reachable advisor wins).

**Panel escalation** adds a second opinion on top: pass `--panel`, or let it fire automatically when
the advisor self-reports confidence below `panel_threshold`. Panelists (`roles.panel`) run
**concurrently**, are trust-filtered exactly like the advisor, and a failing panelist is recorded
without sinking the panel. Two deliberate honesty rules:

- **askup does not judge whether the views agree.** Free-text agreement detection is not
  deterministic, so with no `roles.reconciler` configured the panel reports `agreement: "unassessed"`
  and shows every view — it will not manufacture a consensus verdict.
- **A reconciler that fails is reported as `reconciler-failed`**, never silently downgraded to
  "unassessed" — a broken synthesis model must not look like an absent one.

Configure a `roles.reconciler` (a *capable* model — reconciling several views is harder than
answering, and small models routinely miss the section contract) to get a real synthesis pass that
names the dissent. A panel drawn from one provider family is flagged as `correlated`.

## Roles → models (config)

Everything is roles mapped to model entries; a model entry declares provider, invocation, and a
user-assigned trust class. No model IDs live in code. Sensitivity **filters** a role's candidates
by trust — there are no separate `*_sensitive` roles.

```yaml
models:
  opus:  { provider: anthropic, id: <id>, invoke: cli,  trust: trusted }
  sol:   { provider: openai,    id: <id>, invoke: codex, trust: untrusted }
  glm:   { provider: ollama,    id: <id>, invoke: http,  trust: untrusted }
  local: { provider: ollama,    id: <id>, invoke: http,  trust: local }

roles:
  advisor: [opus, sol]   # ordered: fallback chain (first reachable wins)
  curator: glm           # optional; omit to use the deterministic template builder

policy:
  default_sensitive: false      # sensitive => only trust: trusted|local advisors are eligible
  max_consults_per_task: 3      # library mode (needs --task-id in CLI mode)
```

`trust: local | trusted | untrusted` is user-assigned and provider-neutral. Sensitive ⇒ `local`+`trusted` only.

## Provider adapters (v0.1 ships four)

| Adapter | Auth | Read-only invocation |
|---|---|---|
| `anthropic-cli` | file-based OAuth token (`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`) or `ANTHROPIC_API_KEY` | request-shaped / no tools (default); `--permission-mode plan` + scoped `--tools` only if explicitly enabled |
| `openai` / `openai-compatible` | `OPENAI_API_KEY` + base URL | request-shaped |
| `ollama` | none (localhost) / Ollama cloud | request-shaped |
| `codex-cli` | ChatGPT subscription via `codex` | `-s read-only` + `--skip-git-repo-check` + prompt on **stdin via `codex exec -`** (keeps it off argv). NOTE: `-s read-only` is a **read-capable agent**, not no-tools — prefer `openai` for a request-shaped OpenAI advisor. |

`anthropic-api` is a thin variant of `anthropic-cli`. Adapters implement one interface —
`invoke(prompt, {timeoutMs}) -> { text, usage? }` — and fail fast on stall (ported from the
Codex guardrails). Provider is pluggable.

### Sandbox note
Calling a hosted advisor from inside a sandboxed worker needs (a) auth that doesn't require the OS
keychain (the file-based token) and (b) network egress, which some sandboxes block by default.
Ship the scoped, opt-in network launcher as an optional helper — never global. Document the
trade-off (open egress = a compromised worker can exfiltrate).

## Interfaces

- **CLI:** `askup consult --context - [--sensitive] [--no-curate] [--json]` (question/context via stdin);
  plus `askup init | doctor | config`. Distinct exit codes: ok / refused-by-policy / provider-error /
  limit-exceeded / low-confidence.
- **Library:** `consult({ question, context, sensitive }) -> StructuredRecommendation`.
- **Tool-loop shim (v0.1):** a JSON tool-schema + drop-in examples for an Ollama tool loop and
  OpenAI function-calling — the primary adoption artifact.
- **MCP server (v0.1.x):** one `consult` tool — the cross-ecosystem adoption path (language-invisible).

## StructuredRecommendation (stable, versioned)

Problem Assessment · Verified Facts · Assumptions/Uncertainties · Recommended Approach · Why ·
Implementation Guidance · Alternatives · Risks · Validation Plan · Confidence (0–100) ·
Provenance (models used, curated y/n, **token counts / cost where the API reports usage**).

## Not this
No agent runtime, router, workflow engine, or model gateway. No telemetry. No persistent state
beyond an optional consult log (never secrets, never full prompts by default).

---
Full internal spec (source of truth): Obsidian vault
`02 Projects/Advisory Channel/specs/2026-07-16-oss-advisory-channel.md`.
