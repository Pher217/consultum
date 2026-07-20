# Adding a provider

A provider adapter is one small module plus one registry entry. Adapters are the only place that
knows how to talk to a model host; everything else works in terms of the `invoke` contract.

## The contract

```js
// src/providers/<name>.js
import { AskupError, KIND } from '../errors.js';

export function create(model, deps) {
  return {
    provider: '<name>',
    model,
    async invoke(prompt, { timeoutMs, system } = {}) {
      // 1. NO TOOLS by default. Send a request-shaped call — the packet is the advisor's whole
      //    world. If your host supports tools, do NOT enable them here (see docs/threat-model.md A2).
      // 2. Use the injected primitives so the contract tests run with no live provider:
      //      deps.httpPostJson(url, body, { headers, timeoutMs })  -> parsed JSON (throws on non-2xx)
      //      deps.runWithStdin(cmd, args, { input, timeoutMs })    -> { code, stdout, stderr, timedOut }; prompt via stdin
      // 3. Honor timeoutMs (fail fast on stall).
      // 4. Empty output is an ERROR, never a silent success.
      // 5. Return { text, usage? } where usage = { promptTokens, completionTokens }.
      const data = await deps.httpPostJson(`${model.baseUrl}/...`, { model: model.id, /* ... */ }, { timeoutMs });
      const text = (data?.text || '').trim();
      if (!text) throw new AskupError(KIND.PROVIDER_ERROR, `<name> (${model.id}) returned no content`);
      return { text };
    },
  };
}
```

Rules that the contract test (`test/providers.test.js`) enforces, and your adapter must satisfy:

- **No tools by default.** No `tools`/`functions` field in an HTTP body; no tool-granting flags on a
  CLI. Filesystem access, if a host supports it, is opt-in via `model.tools = { allow, dirs }` and is
  **directory-scoped** — `config.js` refuses `allow` without `dirs`.
- **Prompt always goes on stdin, no exceptions.** Never pass the prompt as a shell argument — argv
  leaks to `ps` and any other process on the box. Even the `codex-cli` adapter, which shells out to a
  CLI, feeds the prompt via `codex exec -` (stdin), using `deps.runWithStdin`. See the threat model (A6).
- **Secrets come from the environment by default**, named by `model.apiKeyEnv`. Config-driven,
  keychain-free credentials are also supported for sandboxed callers — `api_key_file` (HTTP adapters)
  or `token_file` (CLI adapters) — resolved through the single credential path in `src/credential.js`,
  which enforces the shape gate (single line, size-capped, perm-checked). Use that module rather than
  reading credential files yourself.

## Register it

```js
// src/providers/index.js
import { create as myProvider } from './my-provider.js';
const FACTORIES = { /* ... */ 'my-provider': myProvider };
```

Add `'my-provider'` to `KNOWN_PROVIDERS` in `src/config.js`, add a reachability branch to
`defaultProbe` in `src/cli.js` (so `askup doctor` can report it), and add a contract test.

## Trust, not provider identity

A provider is not inherently trusted or untrusted — the **user** assigns `trust: local | trusted |
untrusted` per model in their config, and a sensitive request filters to `trusted`/`local` only. Your
adapter does not decide trust; it just talks to the host.
