# consultum

[![npm](https://img.shields.io/npm/v/consultum)](https://www.npmjs.com/package/consultum) [![CI](https://github.com/Pher217/consultum/actions/workflows/ci.yml/badge.svg)](https://github.com/Pher217/consultum/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md) [![GitHub stars](https://img.shields.io/github/stars/Pher217/consultum?style=social)](https://github.com/Pher217/consultum/stargazers)

> **The advisory escalation frontier agents get natively — made open, and cross-provider.**

When a delegated AI worker gets stuck, it should be able to *ask up* — escalate to a stronger model — instead of guessing. A Claude agent can spawn an advisory subagent to do exactly that. A worker running in a tool loop, or a model boxed inside a sandbox, **can't** — it's isolated. `consultum` is that missing channel, open to any engine and any provider: a stuck worker sends a curated, secret-redacted packet to a stronger **advisor** — Claude, GPT/Codex, or a local model — and gets a structured, read-only recommendation back. **One open advisory channel. Any worker, any provider.**

**Status: v0.1.** `npm install -g consultum` (or `npx consultum`) → `consultum init` → `consultum doctor` → `consultum consult`. Provider-agnostic, security-first (see below). See [`docs/architecture.md`](docs/architecture.md) and [`docs/threat-model.md`](docs/threat-model.md).

---

## The problem

A good multi-model workflow looks like this:

> **A frontier orchestrator model drives the conversation and owns every decision.** To save tokens, it delegates *clear, well-specified tasks* to cheaper mid-tier workers — hosted or local. Work comes back and is **verified** — by the orchestrator, and cross-checked by other reviewers. This works well.

But there's a gap: **the workers can't talk to each other.** An agentic session can spawn an advisory subagent when it's stuck. A worker running in a tool loop, or a model inside a sandbox, cannot — it's isolated. When such a worker hits something above its weight class, it either **guesses** (bad) or **dead-ends** (wasteful).

`consultum` is the missing channel: a worker packages its problem, a **curator** model compresses the mess into clean evidence, and the whole thing **escalates to a higher-tier advisor**. The advisor answers; the worker continues. Ownership never leaves the orchestrator.

## How it works

![The advisory channel — cheap workers ask up to a strong advisor through a high-context curator that redacts and compresses](docs/advisory-channel.svg)

Cheap workers do the typing. When one is **stuck**, it asks up: a high-context **curator** redacts secrets and compresses the mess into a clean packet, then a stronger **advisor** reviews it **read-only** and answers. The worker keeps going — the decision never leaves the orchestrator.

Any engine can open it:
- a Claude-style worker via a subagent,
- a Codex/GPT-style worker via a CLI call (or a peer advisor),
- an Ollama worker via a `consult_advisor` tool in its loop.

## Quickstart

```bash
npm install -g consultum
consultum init            # detects claude/codex/ollama, writes ./consultum.yaml
consultum doctor          # checks reachability + local auth for every provider; verifies the exact
                          # model id only for locally-pulled Ollama tags — everything else reports
                          # ok-unverified (reachable/usable, id not confirmed against the provider)
echo "Why is my nightly job dropping rows?" | consultum consult
```

### The stdin protocol

Question and context always arrive on **stdin**, never argv — argv leaks to any other process on
the box via `ps`. Two accepted shapes:

- JSON: `{"question": "...", "context": "..."}`
- Plain text: first line is the question, the rest is context.

```bash
consultum consult <<'EOF'
Why is my nightly job dropping rows?
It's a Postgres COPY into a partitioned table, no errors logged, ~2% of rows missing.
EOF
```

### Example output (abridged)

```
=== consultum recommendation ===
advisor: gemma3:4b (ollama)   curated: no   confidence: 75/100   sensitive: no

## Problem Assessment
...
## Recommended Approach
...
## Confidence
75
```

### Exit codes

| Code | Meaning |
|---|---|
| `0` | ok |
| `10` | usage error |
| `11` | refused by policy |
| `12` | provider error |
| `13` | limit exceeded |
| `14` | low confidence (recommendation is still printed) |
| `15` | malformed advisor output |

### Second opinion: the panel

When one advisor isn't enough, configure `roles.panel` and pass `--panel`: every panelist is asked
the same question **concurrently** and you get each view back.

consultum deliberately does **not** compute an "they agree" verdict over free text — deciding whether
two prose recommendations agree isn't deterministic, and a cheap keyword check would be a confident
lie exactly where you'd most trust it. So either you configure a `reconciler` model, which
synthesizes the views and is instructed to **name the dissent** and lower its confidence when they
diverge, or `agreement` stays `unassessed` and you read the views yourself. If every panelist fails,
that's reported as *not convened* — never as an empty consensus.

A panel also fires **automatically** on a low-confidence answer when one is configured. Set
`policy.panel_auto: false` to require an explicit `--panel`.

### Cost

A consult is **one advisor call**, plus **one curator call** if a curator is configured. A panel
adds **one call per panelist** (capped at 5), plus the reconciler if you configured one — so a
panelled consult can be six or more billed requests from a single command. Both the panel and
auto-panel are opt-in for that reason.

These are real calls to whatever model you've wired into your config — on a hosted provider
(Anthropic, OpenAI, an OpenAI-compatible endpoint) this spends real money. Point
`advisor`/`curator`/`panel` at local Ollama models to run for free.

### Requirements

Node >= 20. Runs on macOS, Linux, and Windows — see [`docs/windows.md`](docs/windows.md) for the
CLI-adapter caveats on Windows.

## Design principles

- **Open & provider-agnostic.** No lock-in, no hardcoded model names. Roles (curator, advisor, panel) map to models in one config file — mix Anthropic, OpenAI/Codex, Ollama, and any OpenAI-compatible endpoint freely: a frontier advisor with a cheap local curator, a hosted advisor with a local fallback, whatever fits. Adding a provider is one adapter.
- **The advisor advises; it never decides.** `consultum` returns a structured recommendation with a confidence score and any dissent. The caller stays the decision-owner.
- **Two hops on purpose.** A high-context, cheap *curator* turns a weak worker's messy dump into a tight, fact-vs-assumption packet, so the expensive advisor spends its tokens reasoning, not parsing. (Optional; off by default.)
- **Fail-closed on sensitive data.** Mark a request sensitive and only `trusted`/`local` advisors are eligible — any model you labelled `untrusted` is skipped, never silently used. (Trust is a label you assign per model, so a hosted provider you trust can still serve sensitive requests; it's your policy, enforced.) Secrets are redacted before any cross-model send.
- **Clean & simple.** One command to install, one small config file to configure, `consultum doctor` to tell you what's reachable.

## Security posture (read this)

This tool ships *your code's context* to model providers, so security is first-class — see [`docs/threat-model.md`](docs/threat-model.md). Three things worth stating up front:

1. **The advisor runs with no tools by default** — the curated packet is its entire world. "Read-only" is *not* a safety guarantee: a filesystem-equipped advisor reachable through an injectable packet could read local secrets and echo them back. Filesystem access is opt-in, directory-scoped, and restricted to read-only tools. **One exception to know:** the `codex-cli` adapter (`codex exec -s read-only`) is a *read-capable agent*, not a no-tools advisor — prefer the `openai` adapter for a request-shaped OpenAI advisor, and never point `codex-cli` at sensitive data. See [`docs/threat-model.md`](docs/threat-model.md).
2. **The returned recommendation is untrusted input.** It is aimed at the *weakest* model in the system. Never pipe an advisor's implementation guidance to a shell unexamined; output is schema-validated and linted for embedded shell/network commands.
3. **Redaction is best-effort** against *accidental* leakage, not adversarial encoding. No telemetry — `consultum` phones home to nobody but the model providers you configure.

## Use it from any language

consultum's core is Node, but you drive it over a clean process contract — question + context on stdin, a JSON recommendation on stdout, machine-readable exit codes — so any language works. See [`docs/calling-from-python.md`](docs/calling-from-python.md) for a ~15-line Python wrapper. (A native MCP server, so MCP-native agent frameworks can call `consult` as a tool, is on the roadmap.)

## Non-goals

Not an agent runtime, task router, workflow engine, or model gateway. `consultum` does exactly one thing: **controlled escalation from a weaker executor to a stronger advisor, with context curation and safety.**

## Docs

| Doc | What's in it |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Internal flow, config schema, provider adapters, interfaces |
| [`docs/library-api.md`](docs/library-api.md) | Using consultum as a Node library — `consult`, `consultumTool`, config, errors |
| [`docs/threat-model.md`](docs/threat-model.md) | Trust boundaries, attack scenarios, mitigations |
| [`docs/when-to-consult.md`](docs/when-to-consult.md) | When escalating to an advisor is (and isn't) worth it |
| [`docs/adding-a-provider.md`](docs/adding-a-provider.md) | How to write a new provider adapter |
| [`docs/sandboxed-callers.md`](docs/sandboxed-callers.md) | Calling consultum from inside a sandboxed worker |
| [`docs/windows.md`](docs/windows.md) | Windows support matrix and caveats |
| [`docs/calling-from-python.md`](docs/calling-from-python.md) | Driving consultum from Python (or any language) |

## License

MIT © Pher217
