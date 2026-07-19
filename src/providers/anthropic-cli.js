// anthropic-cli — headless `claude -p`. Works where the OS keychain doesn't (file-based OAuth
// token via `claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN), which is why it exists alongside the
// request-shaped anthropic-api variant.
//
// NO-TOOLS BY DEFAULT (§18, threat-model A2): the curated packet is the advisor's entire world.
// "Read-only" is not a safety property — a filesystem-equipped advisor reached through an injectable
// packet can read local secrets and echo them back. Filesystem tools are opt-in AND directory-scoped
// (config `tools: { allow: [...], dirs: [...] }`), never on by default.

import { AskupError, KIND } from '../errors.js';

const DEFAULT_TIMEOUT_MS = 240_000;

export function create(model, deps) {
  return {
    provider: 'anthropic-cli',
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const args = ['-p', '--model', model.id, '--permission-mode', 'plan'];
      if (model.tools && model.tools.allow.length > 0) {
        // opt-in, directory-scoped tools — only the configured allowlist, only within the given dirs
        args.push('--tools', model.tools.allow.join(','));
        for (const dir of model.tools.dirs) args.push('--add-dir', dir);
      } else {
        args.push('--tools', ''); // explicit empty allowlist — no tools reachable
      }
      // Prompt via STDIN, never argv (A6: argv leaks to `ps`/shell history). `claude -p` reads the
      // prompt from stdin when none is given as an argument.
      const input = system ? `${system}\n\n${prompt}` : prompt;
      const res = await deps.runWithStdin('claude', args, { timeoutMs, input });
      if (res.timedOut) throw new AskupError(KIND.PROVIDER_ERROR, `claude (${model.id}) timed out after ${timeoutMs}ms`);
      const text = (res.stdout || '').trim();
      if (!text) {
        throw new AskupError(
          KIND.PROVIDER_ERROR,
          `claude (${model.id}) returned no output (exit ${res.code}): ${(res.stderr || '').trim().slice(-200)}`,
        );
      }
      return { text };
    },
  };
}
