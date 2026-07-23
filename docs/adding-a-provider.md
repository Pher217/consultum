# Adding a provider

A provider adapter is one small module plus one registry entry. Adapters are the only place that
knows how to talk to a model host; everything else works in terms of the `invoke` contract.

## The contract

```js
// src/providers/<name>.js
import { ConsultumError, KIND } from '../errors.js';

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
      if (!text) throw new ConsultumError(KIND.PROVIDER_ERROR, `<name> (${model.id}) returned no content`);
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

## Registration checklist

A new provider must be wired in every place below, in order. Each step names the exact file/symbol
to touch — missing any one leaves the adapter reachable from one path but dead from another (config
validation, `doctor`, typed consumers, the docs, the test suite).

1. **Create the adapter** at `src/providers/<name>.js` implementing the `create(model, deps)`
   contract from the section above: `invoke(prompt, { timeoutMs }) -> { text, usage? }`, no tools by
   default, prompt on stdin, fail fast on stall, empty output is an error.

2. **Register the factory.** Add an import and one entry to the `FACTORIES` map in
   `src/providers/index.js`:

   ```js
   // src/providers/index.js
   import { create as myProvider } from './my-provider.js';
   const FACTORIES = { /* ... */ 'my-provider': myProvider };
   ```

   `createProvider()` resolves a model entry through this map; without an entry the adapter throws
   `no adapter for provider '<name>'` at consult time.

3. **Whitelist the provider string.** Add `'<name>'` to the `KNOWN_PROVIDERS` set in
   `src/config.js`. `normalizeConfig()` rejects any model whose `provider` is not in this set with a
   usage error at parse time, so the adapter is unusable from config until it is listed here.

4. **Add a reachability branch to `defaultProbe`** in `src/cli.js`, so `consultum doctor` can report
   the host. Mirror an existing branch — HTTP adapters return a status from
   `httpAuthedStatus(model, base, envName, reachPath)`; CLI adapters use `cliStatus(cmd, model,
   tokenEnv)`; Ollama uses `ollamaStatus(base, id)`. A provider without a branch falls through to
   `{ status: 'unknown', detail: 'unknown provider' }`.

5. **Extend the `ProviderName` union** in `types/index.d.ts` so TypeScript consumers (and
   `test/contract/ts-consumer.ts`) see the new provider in `ModelSpec.provider`, `PanelView.provider`,
   and `Provenance.advisorProvider`.

6. **Document the adapter.** Add a row to the provider-adapters table in `docs/architecture.md`
   (under `## Provider adapters (v0.1 ships six)`), and update the `(v0.1 ships six)` count in that
   heading if your addition changes the total number of shipped adapters.

7. **Note Windows caveats** — if the adapter shells out to a CLI rather than speaking HTTP, record
   any platform-specific behaviour (quoting, PATH/`.exe` resolution, stdin handling) in
   `docs/windows.md`.

8. **Add tests.** Add a unit test in `test/providers.test.js` exercising the adapter's contract
   against injected fakes: no tools by default (where the host supports tools), the prompt leaves via
   stdin and never argv, empty/blank output throws rather than returning a silent success, and a stall
   fails fast once `timeoutMs` elapses. If the adapter should ship in the packed tarball, also add it to
   the packed-contract suite in `test/contract/pack-contract.mjs`.

## Trust, not provider identity

A provider is not inherently trusted or untrusted — the **user** assigns `trust: local | trusted |
untrusted` per model in their config, and a sensitive request filters to `trusted`/`local` only. Your
adapter does not decide trust; it just talks to the host.
