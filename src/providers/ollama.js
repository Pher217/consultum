// ollama — local (localhost) or Ollama-cloud model tags via the /api/chat endpoint. Request-shaped:
// no `tools` key is ever sent, so the model cannot call a function. Reports token usage when present.

import { AskupError, KIND } from '../errors.js';
import { redactSecrets } from '../redact.js';

const DEFAULT_BASE = 'http://localhost:11434';
const DEFAULT_TIMEOUT_MS = 240_000;

export function create(model, deps) {
  const base = (model.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  return {
    provider: 'ollama',
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      let data;
      try {
        data = await deps.httpPostJson(`${base}/api/chat`, { model: model.id, messages, stream: false }, { timeoutMs });
      } catch (err) {
        throw new AskupError(KIND.PROVIDER_ERROR, `ollama (${model.id}) failed: ${redactSecrets(err.message)}`, { cause: err });
      }
      const text = (data?.message?.content || '').trim();
      if (!text) throw new AskupError(KIND.PROVIDER_ERROR, `ollama (${model.id}) returned no content`);
      const usage =
        data.prompt_eval_count != null || data.eval_count != null
          ? { promptTokens: data.prompt_eval_count ?? null, completionTokens: data.eval_count ?? null }
          : undefined;
      return usage ? { text, usage } : { text };
    },
  };
}
