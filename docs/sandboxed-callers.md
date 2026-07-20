# Calling askup from inside a sandbox

`askup` runs as a normal process, so most setups need nothing special. The one hard case is when
**askup is invoked from inside a restricted sandbox** — e.g. a Codex worker — that blocks the OS
keychain *and* network egress. This is the old "Codex → Claude" pain. Here's how to make it easy.

## 1. Prefer the HTTP adapters

The HTTP adapters (`anthropic-api`, `openai`/`openai-compatible`, `ollama`) are the easy path: each
needs only an **env-var or file key** and **one reachable host** — no OS keychain, no bundled CLI.
`askup init --sandbox` scaffolds exactly this:

```bash
askup init --sandbox --config "$HOME/.config/askup/config.yaml"
```

| Provider | Egress host to allowlist | Credential |
|---|---|---|
| `anthropic-api` | `api.anthropic.com` | `ANTHROPIC_API_KEY` (env) or `api_key_file` |
| `openai` / `-compatible` | your `base_url` host (default `api.openai.com`) | `OPENAI_API_KEY` (env) or `api_key_file` |
| `ollama` | `localhost:11434` (usually allowed) or your cloud tag host | none / cloud |

The CLI adapters (`anthropic-cli`, `codex-cli`) are harder inside a sandbox: they need the binary on
PATH and the tool's own auth. If you must use `anthropic-cli`, use a **file-based token** so it never
touches the keychain (next section).

## 2. Keychain-free auth (file-based token / key)

Mint a token once and store it in a 600-perm file outside any repo:

```bash
claude setup-token                                  # prints an sk-ant-oat... token
umask 077; printf '%s' '<token>' > "$HOME/.config/askup/claude-token"
chmod 600 "$HOME/.config/askup/claude-token"
```

Point a model at it:

```yaml
models:
  claude:
    provider: anthropic-cli
    id: claude-claude-4-8
    trust: trusted
    token_file: ~/.config/askup/claude-token   # injected as CLAUDE_CODE_OAUTH_TOKEN into the subprocess
    # token_env: CLAUDE_CODE_OAUTH_TOKEN        # override the var name if your file holds an API key
  gpt:
    provider: openai
    id: gpt-4o
    trust: untrusted
    api_key_file: ~/.config/askup/openai-key    # read instead of OPENAI_API_KEY
```

Rules askup enforces on a credential file (so a hostile config can't turn an arbitrary file into an
exfiltrated header — see `docs/threat-model.md` A7): it must be a **single line**, **≤ 4 KB**, and
(on POSIX) **not group/world-readable** (`chmod 600`). Paths resolve relative to the config file's
directory. Override the perm check only for container-mounted secrets: `ASKUP_ALLOW_INSECURE_CREDENTIAL_PERMS=1`.

## 3. Keep the config OUTSIDE the workspace (important)

`askup` discovers `./askup.yaml` before `~/.askup.yaml`. Inside a sandbox, the worker can usually
**write its own working directory** — so a config left in the workspace is attacker-writable, and a
hostile config can redirect a credential to an attacker's `base_url` (threat-model A7). **Pin the
config to a path the worker cannot write** and pass it explicitly:

```bash
export ASKUP_CONFIG="$HOME/.config/askup/config.yaml"   # outside the sandbox workspace
askup doctor          # verify reachability + auth before consulting
```

`askup doctor` probes **credential-free** (it never sends your key) and tells you `ok` vs
`not-authed` vs `egress-blocked` vs `dns-fail`, so a blocked sandbox is a diagnosis, not a mystery
hang. It exits non-zero if no advisor is usable.

## 4. If egress itself is blocked (the deferred piece)

Some sandboxes (Codex) block outbound network entirely, and the only way through is to launch the
**host engine** with egress on. That is **the host engine's launch decision, not askup's** (askup is
not an engine launcher — see the non-goals).

### The flag only works in `workspace-write` mode (verified 2026-07-20)

`-c sandbox_workspace_write.network_access=true` is, as the key name says, scoped to the
**workspace-write** sandbox. Under `-s read-only` it is **silently ignored** — no warning, no error,
just a network failure that looks like a broken tool. Measured, same command each time:

| Codex invocation | askup result |
|---|---|
| `-s read-only` (no flag) | `provider-error` · `fetch failed` in ~292 ms |
| `-s read-only -c sandbox_workspace_write.network_access=true` | **still** `fetch failed` in ~275 ms — flag ignored |
| `-s workspace-write -c sandbox_workspace_write.network_access=true` | **exit 0**, advisor answered |

So a consult from inside a read-only Codex worker **cannot reach the network at all**, and no
config key changes that.

> **The trade-off, stated plainly:** to get egress you must grant **workspace-write** — a strictly
> broader permission — even though an askup consult writes nothing. There is no "read-only + network"
> option here. If you are not willing to grant write access, **do not** try to consult from inside the
> sandbox: run askup from the host (outside the sandbox) and pass the worker its result, or use the
> parent-mediated relay (the dispatching agent performs the consult on the worker's behalf).

Two more things to understand before enabling egress at all:

- **It opens egress for the whole session, not just one consult.** Every command that session runs
  can then reach the network. A compromised or prompt-injected worker can exfiltrate. Keep bulk
  workers egress-off; only open egress for a session that specifically needs to consult.
- Combine it with the file-based token (section 2) so the sandboxed `claude`/`codex` call can
  authenticate without the keychain.

askup deliberately does **not** ship a command that opens a sandbox's egress — that would make it the
thing that both injects a credential and opens the network in one step. This recipe is documentation;
a supported example launcher may land in a future release if there's real demand.
