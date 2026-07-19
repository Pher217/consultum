// codex-cli — OpenAI models through the ChatGPT-subscription `codex` CLI. The most battle-tested,
// most differentiated adapter: it ships the exact invocation fix that took real debugging.
//
// codex `exec` needs THREE things or it hangs / returns empty:
//   1. `--skip-git-repo-check`  — to run outside a trusted git dir
//   2. `-s read-only`           — request-shaped, no mutation (still not a disclosure guarantee)
//   3. a REAL /dev/null stdin   — a pipe (e.g. an empty-string input) makes codex print
//                                 "Reading additional input from stdin..." and hang; it needs an
//                                 EOF'd stdin to use the arg prompt. Handled by runNoStdin().
//
// Residual (documented, threat-model A6): codex has no stdin-prompt mode, so the prompt is passed on
// argv and is visible to `ps` for the lifetime of the call. Do not send secrets; redaction runs first.

import { AskupError, KIND } from '../errors.js';

const DEFAULT_TIMEOUT_MS = 240_000;

export function create(model, deps) {
  return {
    provider: 'codex-cli',
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const full = system ? `${system}\n\n${prompt}` : prompt;
      const res = await deps.runNoStdin(
        'codex',
        ['exec', '--skip-git-repo-check', '-s', 'read-only', '-m', model.id, full],
        { timeoutMs },
      );
      if (res.timedOut) throw new AskupError(KIND.PROVIDER_ERROR, `codex (${model.id}) timed out after ${timeoutMs}ms`);
      const text = (res.stdout || '').trim();
      if (!text) {
        throw new AskupError(
          KIND.PROVIDER_ERROR,
          `codex (${model.id}) returned no output (exit ${res.code}): ${(res.stderr || '').trim().slice(-200)}`,
        );
      }
      return { text };
    },
  };
}
