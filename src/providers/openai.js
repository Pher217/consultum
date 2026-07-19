// openai / openai-compatible — the OpenAI Chat Completions API and any endpoint that speaks it
// (Together, Groq, OpenRouter, local vLLM, LM Studio, …) via `base_url`. Request-shaped: no `tools`
// key is sent. The API key is read from the env var named by the model's `api_key_env`
// (default OPENAI_API_KEY) — never from config.

import { AskupError, KIND } from '../errors.js';

const DEFAULT_BASE = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 240_000;

export function create(model, deps) {
  const base = (model.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  const keyEnv = model.apiKeyEnv || 'OPENAI_API_KEY';
  return {
    provider: model.provider, // 'openai' or 'openai-compatible'
    model,
    async invoke(prompt, { timeoutMs = model.timeoutMs || DEFAULT_TIMEOUT_MS, system } = {}) {
      const key = process.env[keyEnv];
      if (!key) throw new AskupError(KIND.PROVIDER_ERROR, `${keyEnv} not set for model ${model.id}`);
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
        throw new AskupError(KIND.PROVIDER_ERROR, `openai (${model.id}) failed: ${err.message}`, { cause: err });
      }
      const text = (data?.choices?.[0]?.message?.content || '').trim();
      if (!text) throw new AskupError(KIND.PROVIDER_ERROR, `openai (${model.id}) returned no content`);
      const u = data.usage;
      const usage = u ? { promptTokens: u.prompt_tokens ?? null, completionTokens: u.completion_tokens ?? null } : undefined;
      return usage ? { text, usage } : { text };
    },
  };
}
