// Provider registry: resolve a model entry to an adapter instance. Adapters receive their runtime
// primitives (subprocess / HTTP) via dependency injection so the contract tests run with no live
// provider. Adding a provider = one entry here + one module implementing `create(model, deps)`.

import { defaultRuntime } from '../run.js';
import { AskupError, KIND } from '../errors.js';
import { create as anthropicCli } from './anthropic-cli.js';
import { create as anthropicApi } from './anthropic-api.js';
import { create as openai } from './openai.js';
import { create as ollama } from './ollama.js';
import { create as codexCli } from './codex-cli.js';

const FACTORIES = {
  'anthropic-cli': anthropicCli,
  'anthropic-api': anthropicApi,
  openai,
  'openai-compatible': openai, // same wire protocol, different base_url
  ollama,
  'codex-cli': codexCli,
};

export function createProvider(model, deps = defaultRuntime) {
  const factory = FACTORIES[model.provider];
  if (!factory) throw new AskupError(KIND.USAGE, `no adapter for provider '${model.provider}'`);
  return factory(model, deps);
}

export function knownProviders() {
  return Object.keys(FACTORIES);
}
