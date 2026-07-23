# Library API

`consultum` is usable as a Node library, not just a CLI. The package is ESM, ships hand-written
TypeScript declarations ([`types/index.d.ts`](../types/index.d.ts)), and has one runtime dependency
(`yaml`).

```bash
npm install consultum
```

```js
import { consult, loadConfig } from 'consultum';
```

## `consult(options) => Promise<StructuredRecommendation>`

Runs one consult: redact → (optional) curate → advise over the trust-filtered fallback chain →
schema-validate + lint → return. It **never decides** — it returns a recommendation for you to weigh.
It **throws** a `ConsultumError` rather than silently downgrading a sensitive request.

```js
import { consult, loadConfig, ConsultumError } from 'consultum';

const config = loadConfig();                 // discover ~/.consultum.yaml etc. (see below)
try {
  const rec = await consult({
    question: 'Why is my nightly COPY dropping ~2% of rows?',
    context: 'Postgres, partitioned table, no errors logged.',
    config,
  });
  console.log(rec.recommendation, rec.confidence);
  if (rec.lowConfidence) console.warn('advisor was below the panel threshold');
} catch (e) {
  if (e instanceof ConsultumError) console.error(e.kind, e.message); // e.g. 'refused-by-policy'
  else throw e;
}
```

Key `ConsultOptions` fields (full list in the types):

| Field | Meaning |
|---|---|
| `question` (required) | The question. |
| `context` | Rough context/packet. |
| `sensitive` | Escalate-only — may force a request sensitive, never de-escalate one. |
| `curate` | Override `policy.curate` for this call. |
| `panel` | Convene a panel (one paid call per panelist). **Host-controlled** — never expose this to an untrusted worker; use `consultumTool` for that. |
| `sourcePath` | Host-supplied path for per-path sensitivity rules (`policy.sensitive_paths`). |
| `config` | A `ConsultumConfig` (from `loadConfig`/`parseConfig`); omit to auto-discover. |
| `taskId` + `state` | Enable the consult-budget / dedup guard (library-mode cost control). |

The return value is a `StructuredRecommendation`: `schemaVersion`, the prose sections (`problem`,
`facts`, `assumptions`, `recommendation`, `why`, `implementation`, `alternatives`, `risks`,
`validation`), a self-reported `confidence` (0–100) + `lowConfidence`, a `warnings` array (embedded
shell/network commands the lint caught — **never execute advisor output unexamined**), an optional
`panel` result, and `provenance` (models used, curation status, token usage where the provider
reports it).

## `consultumTool(args, opts) => Promise<{ ok, ... }>`

The tool-loop shim — a drop-in for an agent's function-calling loop (Ollama native tools / OpenAI
tools), mirroring the `consult_advisor` tool. **It never throws**: a failure comes back as
`{ ok: false, error: { kind, message } }` so a tool loop always gets a JSON-safe result.

`args` are model-facing (what the weak worker sends): `{ question, packet, sensitive? }`. `opts` are
host-controlled and never settable by the worker (`config`, `sourcePath`, `taskId`, `panel`, …) — this
split is deliberate, so a worker can't force a paid panel or relax sensitivity.

```js
import { consultumTool, TOOL_SCHEMA } from 'consultum';

// register TOOL_SCHEMA with your function-calling loop, then:
const result = await consultumTool(
  { question: toolCall.question, packet: toolCall.packet },
  { config },
);
if (result.ok) useRecommendation(result); // result spreads the StructuredRecommendation fields
else reportToWorker(result.error.kind, result.error.message);
```

`TOOL_SCHEMA` is the provider-neutral JSON function schema (also emitted to
[`shim/tool-schema.json`](../shim/tool-schema.json)); see the drop-in examples under
[`shim/examples/`](../shim/examples/).

## Config

```js
import { loadConfig, parseConfig } from 'consultum';

const config = loadConfig();                          // discovery order below
const other  = loadConfig({ configPath: '/etc/consultum.yaml' });
const inline = parseConfig('models:\n  ...\n');       // parse a YAML/JSON string directly
```

`loadConfig` discovery order: `$CONSULTUM_CONFIG` → `./consultum.{yaml,yml,json}` →
`$XDG_CONFIG_HOME/consultum/config.*` → `~/.consultum.*`. It throws `ConsultumError` (kind `usage`)
when no config is found or one is invalid. Both return a `ConsultumConfig` (`models`, `roles`,
`policy`).

## Errors & exit codes

```js
import { ConsultumError, KIND, EXIT, exitCodeForKind } from 'consultum';
```

Every failure is a `ConsultumError` carrying a stable `kind` and an `exitCode`:

| `kind` | `exitCode` | Meaning |
|---|---|---|
| `usage` | 10 | bad arguments / config |
| `refused-by-policy` | 11 | sensitive request, no eligible (trusted/local) advisor |
| `provider-error` | 12 | every advisor in the chain failed |
| `limit-exceeded` | 13 | consult budget or dedup guard tripped |
| `low-confidence` | 14 | a recommendation was returned, but below the threshold |
| `malformed-output` | 15 | advisor output failed the parse contract after one retry |

`err.toJSON()` gives the `{ error: { kind, message } }` shape used by `--json` and the shim.
`exitCodeForKind(kind)` maps a kind to its code; `KIND`/`EXIT` are the stable name→value maps.

## Other exports

- `redactSecrets(text)` — best-effort redaction of common secret shapes (defence in depth; **not** a
  guarantee against adversarial encoding).

## Calling from other languages

Not on Node? Drive the CLI over its process contract — question/context on stdin, a JSON
recommendation on stdout, machine-readable exit codes. See
[`calling-from-python.md`](calling-from-python.md).
