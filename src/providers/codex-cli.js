// codex-cli — OpenAI models through the ChatGPT-subscription `codex` CLI.
//
// IMPORTANT SECURITY CAVEAT (Sol review, finding 1): `codex exec -s read-only` is NOT a no-tools
// mode. `read-only` sandboxes *writes*; the agent can still autonomously run read commands and read
// files from its working directory (`.env`, `~/.aws/credentials`, repo secrets). An injected packet
// can therefore ask it to read a local secret and echo it back. This adapter is a READ-CAPABLE AGENT,
// not the request-shaped no-tools advisor the security model wants by default. Treat it accordingly:
//   - do NOT put it first in a default advisor chain aimed at untrusted input;
//   - never use it for sensitive data (it is third-party AND can read the local FS);
//   - prefer the `openai` adapter (genuine no-tools request) for a request-shaped OpenAI advisor.
// See docs/threat-model.md (A2) and docs/adding-a-provider.md.
//
// Invocation: the prompt is fed on STDIN via `codex exec -` (supported — "if `-` is used,
// instructions are read from stdin"), so the packet no longer sits on argv (A6). `--skip-git-repo-
// check` lets it run outside a trusted git dir.

import { AskupError, KIND } from '../errors.js';
import { redactedTail } from '../redact.js';

const DEFAULT_TIMEOUT_MS = 240_000;

export function create(model, deps) {
  return {
    provider: 'codex-cli',
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const full = system ? `${system}\n\n${prompt}` : prompt;
      const res = await deps.runWithStdin(
        'codex',
        ['exec', '--skip-git-repo-check', '-s', 'read-only', '-m', model.id, '-'],
        { timeoutMs, input: full },
      );
      if (res.timedOut) throw new AskupError(KIND.PROVIDER_ERROR, `codex (${model.id}) timed out after ${timeoutMs}ms`);
      // Reject a non-zero exit BEFORE trusting stdout — a failed process can emit partial output that
      // would otherwise be accepted instead of falling through to the next advisor (Sol finding 7).
      if (res.code !== 0) {
        throw new AskupError(KIND.PROVIDER_ERROR, `codex (${model.id}) exited ${res.code}: ${redactedTail(res.stderr)}`);
      }
      const text = (res.stdout || '').trim();
      if (!text) throw new AskupError(KIND.PROVIDER_ERROR, `codex (${model.id}) returned no output`);
      return { text };
    },
  };
}
