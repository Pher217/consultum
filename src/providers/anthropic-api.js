// anthropic-api — the thin request-shaped variant of anthropic-cli: the Anthropic Messages API
// directly. This is the truest no-tools guarantee (no `tools` field is sent, so nothing is callable)
// but it needs an ANTHROPIC_API_KEY rather than the subscription token, and no sandbox egress trick.
// Key is read from the env var named by `api_key_env` (default ANTHROPIC_API_KEY).

import { ConsultumError, KIND } from '../errors.js';
import { redactSecrets } from '../redact.js';
import { resolveCredential } from '../credential.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_TIMEOUT_MS = 240_000;
const MAX_TOKENS = 4096;

export function create(model, deps) {
  const base = (model.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const keyEnv = model.apiKeyEnv || 'ANTHROPIC_API_KEY';
  return {
    provider: 'anthropic-api',
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const key = resolveCredential({ envName: keyEnv, filePath: model.apiKeyFile, configDir: model.configDir, label: `${model.name} api key` });
      if (!key) throw new ConsultumError(KIND.PROVIDER_ERROR, `no API key for model ${model.id} (${keyEnv} not set and no api_key_file)`);
      const body = { model: model.id, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: prompt }] };
      if (system) body.system = system;
      let data;
      try {
        data = await deps.httpPostJson(`${base}/v1/messages`, body, {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          timeoutMs,
        });
      } catch (err) {
        // Redact the cause too — whole-error logging would otherwise surface the raw provider error.
        throw new ConsultumError(KIND.PROVIDER_ERROR, `anthropic-api (${model.id}) failed: ${redactSecrets(err.message)}`, { cause: new Error(redactSecrets(String((err && err.message) || err))) });
      }
      const text = (data?.content?.map((b) => b.text || '').join('') || '').trim();
      if (!text) throw new ConsultumError(KIND.PROVIDER_ERROR, `anthropic-api (${model.id}) returned no content`);
      const u = data.usage;
      const usage = u ? { promptTokens: u.input_tokens ?? null, completionTokens: u.output_tokens ?? null } : undefined;
      return usage ? { text, usage } : { text };
    },
  };
}
