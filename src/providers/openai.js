// openai / openai-compatible — the OpenAI Chat Completions API and any endpoint that speaks it
// (Together, Groq, OpenRouter, local vLLM, LM Studio, …) via `base_url`. Request-shaped: no `tools`
// key is sent. The API key is read from the env var named by the model's `api_key_env`
// (default OPENAI_API_KEY) — never from config.

import { ConsultumError, KIND } from '../errors.js';
import { redactSecrets } from '../redact.js';
import { resolveCredential } from '../credential.js';

const DEFAULT_BASE = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 240_000;

export function create(model, deps) {
  const base = (model.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const keyEnv = model.apiKeyEnv || 'OPENAI_API_KEY';
  return {
    provider: model.provider, // 'openai' or 'openai-compatible'
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const key = resolveCredential({ envName: keyEnv, filePath: model.apiKeyFile, configDir: model.configDir, label: `${model.name} api key` });
      if (!key) throw new ConsultumError(KIND.PROVIDER_ERROR, `no API key for model ${model.id} (${keyEnv} not set and no api_key_file)`);
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });
      let data;
      try {
        data = await deps.httpPostJson(
          `${base}/v1/chat/completions`,
          { model: model.id, messages, stream: false },
          { headers: { Authorization: `Bearer ${key}` }, timeoutMs },
        );
      } catch (err) {
        // Redact the CAUSE too, not just the message: the raw provider error can carry the key (e.g.
        // a URL with the token), and whole-error logging would surface `err.cause` verbatim.
        throw new ConsultumError(KIND.PROVIDER_ERROR, `openai (${model.id}) failed: ${redactSecrets(err.message)}`, { cause: new Error(redactSecrets(String((err && err.message) || err))) });
      }
      const text = (data?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new ConsultumError(KIND.PROVIDER_ERROR, `openai (${model.id}) returned no content`);
      const u = data.usage;
      const usage = u ? { promptTokens: u.prompt_tokens ?? null, completionTokens: u.completion_tokens ?? null } : undefined;
      return usage ? { text, usage } : { text };
    },
  };
}
