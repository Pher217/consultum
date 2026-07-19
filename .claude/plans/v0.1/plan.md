# askup v0.1 — implementation plan

## Context

`askup` is the open-source spin-out of the advisory-escalation channel already built and verified
inside `coding-structure`. A delegated worker of any middle-tier model, on any engine (Ollama tool
loop, Codex sandbox, plain API), cannot escalate a hard problem to a stronger model the way a Claude
subagent can. `askup` is that channel, made provider-agnostic: **controlled escalation from a weaker
executor to a stronger advisor, with optional context curation and safety controls.**

The design is done and Fable-reviewed. Source of truth: vault
`02 Projects/Advisory Channel/specs/2026-07-16-oss-advisory-channel.md` — **§18 "Fable review"
overrides earlier sections.** This plan ports the proven code and encodes §18's controls as code.
It does NOT re-design.

Security-first ordering (Fable's highest-priority item): the **advisor-no-tools/request-shaped
default** and the **threat-model controls** come before feature breadth.

## Non-negotiables (from §18)

1. Advisor invocation is **no-tools / request-shaped by default** — the packet is its whole world.
   Filesystem tools are opt-in **and** directory-scoped only.
2. The returned recommendation is **untrusted**: schema-validate it, lint for embedded shell/network
   commands, document "never pipe implementation guidance to a shell unexamined."
3. Sensitivity is **config-level** (`default_sensitive` + per-path); `--sensitive` may only *escalate*.
4. Trust taxonomy is user-assigned `local | trusted | untrusted`; sensitivity **filters** a role's
   candidates by trust — no separate `*_sensitive` roles.
5. Question + context via **stdin**, not argv (argv leaks to `ps`/history).

## Decisions (confirmed)

- **Node, ESM, MIT.** Node 22 present (`fetch` built-in → no `node-fetch`).
- **Single runtime dep: `yaml`** (eemeli/yaml, pure-JS, zero transitive deps).
- Delivery: **feature branch + PR** (`claude/2026-07-19-v0.1`), commit per phase.
- Advisor output parse contract: **labeled-markdown sections** (robust from CLIs; JSON-from-CLI is
  fragile). Required headers must be present or it's malformed → retry once → error.
- v0.1 ships **four** adapters: `anthropic-cli`, `openai`/`openai-compatible`, `ollama`, `codex-cli`.
  `anthropic-api` is a thin variant of `anthropic-cli`.
- **Deferred to v0.2:** reconciliation panel, MCP server, scoped-network launcher (documented only),
  consult log. v0.1 reliability = ordered availability fallback chain, not a panel.
- Name `askup` is **available on npm** (404). Provisional — verify PyPI/GitHub org before publish;
  spec says skip PyPI, reach Python via the (deferred) MCP server.

## Ported assets (keep verbatim where proven)

From `coding-structure/global/skills/execute-task/index.js`:
- `redactSecrets()` + `SECRET_KEY_WORD` → `src/redact.js` (+ port the 10-case regression).
- `runNoStdin()` + the codex `--skip-git-repo-check` / real-`/dev/null`-stdin fix → `src/run.js`,
  used by `src/providers/codex-cli.js`.
- Curator system prompt + curate hop → `src/curator.js` / `src/prompts.js`.
- `consultAdvisor()` fallback shape → generalized into `src/ladder.js` + `src/consult.js`.

From `coding-structure/global/scripts/{consult-claude.sh,codex-advisor.sh}`: the file-based-token +
scoped-network pattern → documented in `docs/`, shipped as an optional helper (not required).

From `skills/advisor/SKILL.md`: invocation policy, packet format, consultation limits → `docs/when-to-consult.md`.

## Repo layout

```
bin/askup.js              # CLI: consult | init | doctor | config
src/index.js              # library entry: export { consult, askupTool }
src/consult.js            # orchestration: redact→sensitivity→curate→redact→wrap→advise(chain)→validate→provenance
src/config.js             # discovery, load (yaml/json), env overrides, role resolution + trust filter
src/redact.js             # redactSecrets() + SECRET_KEY_WORD (ported)
src/run.js                # runNoStdin() (ported)
src/prompts.js            # curator + advisor system prompts, DATA-wrapper delimiters
src/curator.js            # curate() + buildTemplatePacket() deterministic fallback
src/recommendation.js     # parse markdown→schema, validate required fields, lint shell/net cmds
src/ladder.js             # ordered advisor fallback chain (fail-fast on stall→next)
src/errors.js             # AskupError kinds + exit-code map
src/providers/index.js    # registry name→adapter
src/providers/anthropic-cli.js  openai.js  ollama.js  codex-cli.js
shim/tool-schema.json     # provider-neutral consult_advisor JSON function schema
shim/examples/            # ollama-loop.js, openai-function-calling.js
config.example.yaml       # ≤15-line working example
test/*.test.js            # redact(10-case), config, providers(contract), recommendation, ladder, consult(e2e), cli
docs/when-to-consult.md  adding-a-provider.md  windows.md   (+ existing architecture/threat-model)
.github/workflows/ci.yml
```

## Adapter contract

`invoke(prompt, { timeoutMs, system?, tools? }) -> { text, usage? }`. Request-shaped / no tools by
default. Empty output → throw (never silent). Fail fast on stall (ported Codex guardrails).
- `anthropic-cli`: prompt via **stdin** to `claude -p --model <id> --permission-mode plan` with **no
  tool grants** by default; scoped `--tools` + dir only if config opts in.
- `openai`/`openai-compatible`: `fetch` chat/completions, `OPENAI_API_KEY` + `base_url`, no tools.
- `ollama`: `fetch` `POST /api/chat`, localhost or cloud tag, no tools, `usage` from response.
- `codex-cli`: `codex exec --skip-git-repo-check -s read-only -m <id> <prompt>` with **real
  `/dev/null` stdin** (documented residual: codex requires the prompt on argv).

## Threat-model controls → code (mapping added to docs/threat-model.md)

| Adversary | Control (code) |
|---|---|
| A1 injection | DATA-delimiter wrapper for both hops — `src/prompts.js` |
| A2 secret exfil via tools | no-tools default — every adapter; opt-in dir-scoped only |
| A3 RCE via recommendation | schema-validate + shell/net lint — `src/recommendation.js` |
| A4 redaction bypass | redact twice + fail-closed sensitive routing — `src/redact.js`, `src/consult.js` |
| A5 fail-open sensitivity | config-level default; flag escalate-only — `src/config.js` |
| A6 argv/cred leak | stdin not argv; token by path/env, gitignored — `bin/askup.js`, adapters |

## Exit codes / error kinds (machine-readable, documented)

`0` ok · `10` usage/config · `11` refused-by-policy (sensitive, no eligible advisor) · `12`
provider-error (chain exhausted) · `13` limit-exceeded · `14` low-confidence (rec still emitted) ·
`15` malformed-advisor-output (after retry). `--json` prints `{ error: { kind, message } }` on failure.

## Phases (TDD — test first each phase)

- **P0** skeleton: `package.json` (+`yaml`, `npm i`), `errors.js`, `config.js` (+ `config.test.js`:
  discovery order, env override, role resolution, **sensitivity→trust filter**, fail-closed refuse).
- **P1** `redact.js` + `redact.test.js` (**10-case regression**: AWS/GitHub/OpenAI keys, PEM, JWT,
  DSN, Bearer, key-name assigns, + false-positive guards). Security core.
- **P2** `run.js` + 4 adapters + `providers.test.js` (contract, mocked: no-tools default, timeout
  honored, empty→error, stall→fail-fast). Encodes A2.
- **P3** `prompts.js` (DATA wrapper) + `curator.js` (curate + `buildTemplatePacket`) + tests.
- **P4** `recommendation.js` + `recommendation.test.js` (parse required sections, confidence 0–100,
  **lint flags `curl … | sh` / network cmds**, malformed→retry-once→error). Encodes A3.
- **P5** `ladder.js` + `consult.js` + `src/index.js` + `consult.test.js` (e2e, mocked models: stuck
  question → curated packet → full-schema rec; fallback chain; fail-closed sensitive refuse).
- **P6** `bin/askup.js` (`consult` reads stdin protocol: JSON `{question,context}` or first-line=
  question/rest=context; `init`/`doctor`/`config`; exit codes) + `cli.test.js`.
- **P7** `shim/tool-schema.json` + `shim/examples/*` + `askupTool` library export.
- **P8** `config.example.yaml` (≤15 lines), `docs/{when-to-consult,adding-a-provider,windows}.md`,
  `.github/workflows/ci.yml`, `.gitignore` (+`.claude/worktrees/`), threat-model control table,
  "no telemetry" reaffirmed, README quickstart check.

## Verification (end-to-end)

- `npm test` green (node --test): redaction 10-case, adapter contract, recommendation lint, e2e.
- `node bin/askup.js doctor` prints reachable providers + resolved roles (real: claude/codex/ollama
  all present here).
- `printf 'why is my test flaky?\n---\n<context>' | node bin/askup.js consult --json` against a
  **mocked** provider (env-injected fake adapter) returns a full StructuredRecommendation; a
  `--sensitive` run with only `untrusted` advisors **refuses** with exit 11.
- ≤15-line `config.example.yaml` drives a working `consult` (simplicity acceptance criterion).
- Confirm no secret/token committed; `askup` npm availability re-checked before any publish.

## Routing

Security-critical core (redaction, no-tools adapters, consult orchestration, schema/lint) stays on
Opus — auth/privacy-boundary code is a hard decision-owner exception. Prose docs / CI yaml / shim
examples are mechanical and may be delegated; noted in the session tally.
