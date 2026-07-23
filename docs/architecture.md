# Architecture

`consultum` is a small library + CLI (Node, ESM). It does one thing: **controlled escalation from a
weaker executor to a stronger advisor**, with optional context curation and safety controls.

## Flow

```
Executor (any model/engine, stuck)
  -> consultum consult (question + rough context, {sensitivity})
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

- **consultum does not judge whether the views agree.** Free-text agreement detection is not
  deterministic, so with no `roles.reconciler` configured the panel reports `agreement: "unassessed"`
  and shows every view — it will not manufacture a consensus verdict.
- **A reconciler that fails is reported as `reconciler-failed`**, never silently downgraded to
  "unassessed" — a broken synthesis model must not look like an absent one.

Configure a `roles.reconciler` (a *capable* model — reconciling several views is harder than
answering, and small models routinely miss the section contract) to get a real synthesis pass that
names the dissent. A panel drawn from one provider family is flagged as `correlated`.

**Cost — know this before enabling auto.** One consult with a panel of N costs
`1 primary + N panelists (concurrent) + up to 2 reconciler calls` (the reconciler retries once on
unparseable output, same as the advisor ladder). A weak reconciler therefore costs *two* calls to
still fail. `policy.panel_auto` (default `true`) controls whether a low-confidence answer may convene
one automatically — set it `false` to require an explicit `--panel`, because "a panel is configured"
and "every sub-threshold answer may fan out" are different decisions. Panel calls are *not* counted
against `max_consults_per_task` (that counts consults, not fan-out).

## Roles → models (config)

Everything is roles mapped to model entries; a model entry declares provider, model id, and a
user-assigned trust class. No model IDs live in code. Sensitivity **filters** a role's candidates
by trust — there are no separate `*_sensitive` roles.

See [`config.example.yaml`](../config.example.yaml) for the full, runnable schema. Minimal shape:

```yaml
models:
  claude:  { provider: anthropic-cli, id: claude-opus-4-8, trust: trusted }
  gpt:   { provider: openai,        id: gpt-4o,          trust: untrusted }
  local: { provider: ollama,        id: gemma3:27b,      trust: local }

roles:
  advisor: [claude, gpt]   # ordered: fallback chain (first reachable wins)
  # curator: local       # optional; omit to use the deterministic template builder

policy:
  default_sensitive: false      # sensitive => only trust: trusted|local advisors are eligible
```

`trust: local | trusted | untrusted` is user-assigned and provider-neutral. Sensitive ⇒ `local`+`trusted` only.
Valid `provider` values: `anthropic-cli`, `anthropic-api`, `openai`, `openai-compatible`, `ollama`, `codex-cli`.

## Provider adapters (v0.1 ships six)

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

- **CLI:** `consultum consult [--sensitive] [--no-curate] [--json]` (question/context via stdin);
  plus `consultum init | doctor | config`. Distinct exit codes: ok / refused-by-policy / provider-error /
  limit-exceeded / low-confidence.
- **Library:** `consult({ question, context, sensitive }) -> StructuredRecommendation`.
- **Tool-loop shim (v0.1):** a JSON tool-schema + drop-in examples for an Ollama tool loop and
  OpenAI function-calling — the primary adoption artifact.
- **MCP server (v0.1.x):** one `consult` tool — the cross-ecosystem adoption path (language-invisible).

## StructuredRecommendation (stable, versioned)

Carries `schemaVersion: 1` plus: Problem Assessment · Verified Facts · Assumptions/Uncertainties ·
Recommended Approach · Why · Implementation Guidance · Alternatives · Risks · Validation Plan ·
Confidence (0–100) · Provenance (models used, curated y/n, **token counts / cost where the API
reports usage**).

## Not this
No agent runtime, router, workflow engine, or model gateway. No telemetry. The only persisted state
is the optional per-task consult-budget file used by `--task-id` (a JSON file under the temp dir
tracking consult counts per task), never secrets, never full prompts by default.
