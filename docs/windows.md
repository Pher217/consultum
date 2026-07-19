# Windows support matrix

`askup` is Node/ESM and runs on Windows, but the CLI-shelling adapters carry POSIX-isms that are
worth knowing. The HTTP adapters are fully cross-platform.

| Adapter | Windows status | Notes |
|---|---|---|
| `ollama` | ✅ works | Pure HTTP to `localhost:11434` (or a cloud tag). No shell. |
| `openai` / `openai-compatible` | ✅ works | Pure HTTP. Key from an env var. |
| `anthropic-api` | ✅ works | Pure HTTP (Messages API). Key from an env var. |
| `anthropic-cli` | ⚠️ needs `claude` on PATH | Prompt is fed via stdin (`runWithStdin`), which is cross-platform. Requires Claude Code installed and authed. |
| `codex-cli` | ⚠️ needs `codex` on PATH + stdin note | The `/dev/null` stdin trick is POSIX; on Windows `askup` opens `NUL` instead (handled in `src/run.js`). Requires the Codex CLI installed and authed. |

## The `/dev/null` → `NUL` detail

`codex exec` hangs or returns empty when its stdin is an ordinary pipe — it needs a real, EOF'd
stdin. On POSIX that is `/dev/null`; on Windows it is `NUL`. `runNoStdin()` picks the right one by
`process.platform`, and falls back to Node's `'ignore'` stdio if neither can be opened.

## Concurrency note (CLI-shelling adapters)

The `anthropic-cli` and `codex-cli` adapters spawn a subprocess per call. If you fan out many
concurrent consults through a CLI adapter, you spawn many processes — bound your concurrency. The
HTTP adapters (`ollama`, `openai*`, `anthropic-api`) have no per-call process cost and scale better
for parallel use.

## Recommendation

On Windows, prefer the HTTP adapters (`anthropic-api`, `openai`, `ollama`) for the advisor role. Use
`anthropic-cli` / `codex-cli` only when you specifically want the subscription-token / sandbox path,
and confirm the CLI is on PATH with `askup doctor`.
