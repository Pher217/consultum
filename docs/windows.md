# Windows support matrix

`askup` is Node/ESM and runs on Windows, but the CLI-shelling adapters carry POSIX-isms that are
worth knowing. The HTTP adapters are fully cross-platform.

| Adapter | Windows status | Notes |
|---|---|---|
| `ollama` | ✅ works | Pure HTTP to `localhost:11434` (or a cloud tag). No shell. |
| `openai` / `openai-compatible` | ✅ works | Pure HTTP. Key from an env var. |
| `anthropic-api` | ✅ works | Pure HTTP (Messages API). Key from an env var. |
| `anthropic-cli` | ⚠️ needs `claude` on PATH | Prompt is fed via stdin (`runWithStdin`), which is cross-platform. Requires Claude Code installed and authed. |
| `codex-cli` | ⚠️ needs `codex` on PATH | Prompt is fed via stdin (`codex exec -`, using `runWithStdin`), which is cross-platform. Requires the Codex CLI installed and authed. |

## Concurrency note (CLI-shelling adapters)

The `anthropic-cli` and `codex-cli` adapters spawn a subprocess per call. If you fan out many
concurrent consults through a CLI adapter, you spawn many processes — bound your concurrency. The
HTTP adapters (`ollama`, `openai*`, `anthropic-api`) have no per-call process cost and scale better
for parallel use.

## Credential-file permission checks

File-based credentials (`token_file` / `api_key_file`) are perm-checked on POSIX — a group/world-
accessible file is refused (`chmod 600`). **On Windows this check is skipped**, because Node's
`fs.stat().mode` does not carry meaningful POSIX permission bits there. The single-line and size-cap
gates still apply. Protect credential files with NTFS ACLs, and keep them outside any repo (they are
gitignored by pattern). The `ASKUP_ALLOW_INSECURE_CREDENTIAL_PERMS=1` escape hatch is a no-op on
Windows (the check is already skipped). Env injection into a subprocess (`token_file`) works
identically on Windows.

## Recommendation

On Windows, prefer the HTTP adapters (`anthropic-api`, `openai`, `ollama`) for the advisor role. Use
`anthropic-cli` / `codex-cli` only when you specifically want the subscription-token / sandbox path,
and confirm the CLI is on PATH with `askup doctor`.
