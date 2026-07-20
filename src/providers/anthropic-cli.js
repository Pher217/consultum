// anthropic-cli — headless `claude -p`. Works where the OS keychain doesn't (file-based OAuth
// token via `claude setup-token` → CLAUDE_CODE_OAUTH_TOKEN), which is why it exists alongside the
// request-shaped anthropic-api variant.
//
// NO-TOOLS BY DEFAULT: the curated packet is the advisor's entire world.
// "Read-only" is not a safety property — a filesystem-equipped advisor reached through an injectable
// packet can read local secrets and echo them back. Filesystem tools are opt-in AND directory-scoped
// (config `tools: { allow: [...], dirs: [...] }`), never on by default.

import { ConsultumError, KIND } from '../errors.js';
import { redactedTail } from '../redact.js';
import { readCredentialFile } from '../credential.js';

const DEFAULT_TIMEOUT_MS = 240_000;

export function create(model, deps) {
  return {
    provider: 'anthropic-cli',
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const args = ['-p', '--model', model.id, '--permission-mode', 'plan'];
      if (model.tools && model.tools.allow.length > 0) {
        // Opt-in, directory-scoped read-only tools (config restricts the allowlist to Read/Grep/Glob).
        // CAVEAT: --add-dir ADDS directories; it does not remove the process's own
        // working directory. Run consultum from a directory that holds no secrets when enabling tools —
        // this is a narrow opt-in, not a sandbox. Even Read here can disclose files; it is not a
        // security boundary.
        args.push('--tools', model.tools.allow.join(','));
        for (const dir of model.tools.dirs) args.push('--add-dir', dir);
      } else {
        args.push('--tools', ''); // explicit empty allowlist — no tools reachable
      }
      // Keychain-free auth (the sandbox path): if the token env var isn't already set but a token_file
      // is configured, read it (through the credential shape gate) and inject it into the SUBPROCESS
      // env only — never the parent, never logged. If the env var is already set, the child inherits it.
      const tokenVar = model.tokenEnv || 'CLAUDE_CODE_OAUTH_TOKEN';
      let env;
      if (!process.env[tokenVar] && model.tokenFile) {
        env = { [tokenVar]: readCredentialFile(model.tokenFile, model.configDir, `${model.name} token_file`) };
      }
      // Prompt via STDIN, never argv (A6: argv leaks to `ps`/shell history). `claude -p` reads the
      // prompt from stdin when none is given as an argument.
      const input = system ? `${system}\n\n${prompt}` : prompt;
      const res = await deps.runWithStdin('claude', args, { timeoutMs, input, env });
      if (res.timedOut) throw new ConsultumError(KIND.PROVIDER_ERROR, `claude (${model.id}) timed out after ${timeoutMs}ms`);
      // Reject a non-zero exit before trusting stdout.
      if (res.code !== 0) {
        throw new ConsultumError(KIND.PROVIDER_ERROR, `claude (${model.id}) exited ${res.code}: ${redactedTail(res.stderr)}`);
      }
      const text = (res.stdout || '').trim();
      if (!text) {
        throw new ConsultumError(
          KIND.PROVIDER_ERROR,
          `claude (${model.id}) returned no output (exit ${res.code}): ${redactedTail(res.stderr)}`,
        );
      }
      return { text };
    },
  };
}
