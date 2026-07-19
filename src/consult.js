// consult() — the whole channel in one function:
//   redact → decide sensitivity → (limit check) → curate|template → redact again → wrap as DATA →
//   advise over the fallback chain (retry-once on malformed) → schema-validate + lint → provenance.
//
// It NEVER decides. It returns a StructuredRecommendation (with a confidence and any lint warnings);
// the caller stays the decision-owner. It refuses (throws) rather than silently downgrading a
// sensitive request to a third-party advisor.

import { loadConfig, isSensitive, resolveAdvisorChain, resolveCurator } from './config.js';
import { redactSecrets } from './redact.js';
import { createProvider } from './providers/index.js';
import { curate, buildTemplatePacket } from './curator.js';
import { buildAdvisorPrompt, ADVISOR_SYSTEM } from './prompts.js';
import { parseRecommendation } from './recommendation.js';
import { adviseWithChain } from './ladder.js';
import { consultSignature, checkConsultLimit, recordConsult } from './limits.js';
import { defaultRuntime } from './run.js';
import { AskupError, KIND } from './errors.js';

const CURATOR_TIMEOUT_MS = 90_000;

export async function consult({
  question,
  context = '',
  sensitive = false,
  curate: curateFlag,
  sourcePath = null,
  config,
  deps = defaultRuntime,
  taskId = null,
  state = null,
  advisorTimeoutMs,
  curatorTimeoutMs = CURATOR_TIMEOUT_MS,
} = {}) {
  const cfg = config ?? loadConfig();

  // 1. redact both inputs before anything crosses a model boundary (defence in depth).
  const q = redactSecrets(String(question ?? '').trim());
  const ctx = redactSecrets(String(context ?? '').trim());
  if (!q) throw new AskupError(KIND.USAGE, 'a question is required');

  // 2. sensitivity is config-driven; the flag may only escalate.
  const eff = isSensitive(cfg, { flagSensitive: sensitive, sourcePath });

  // 3. consult limits (library-mode only — needs a taskId + state to count against).
  let sig = null;
  if (taskId && state) {
    sig = consultSignature(q, ctx);
    checkConsultLimit(state, taskId, sig, cfg.policy);
  }

  // 4. resolve the advisor fallback chain, filtered by trust for a sensitive request.
  const chain = resolveAdvisorChain(cfg, { sensitive: eff });
  if (chain.length === 0) {
    throw new AskupError(
      KIND.REFUSED_BY_POLICY,
      eff
        ? 'sensitive request: no trusted/local advisor is configured. Relay the packet manually to a trusted advisor — askup will not send it to a third party.'
        : 'no advisor resolved for this request.',
    );
  }

  // 5. curate (optional, off by default) or build the deterministic template packet.
  const wantCurate = curateFlag ?? cfg.policy.curate;
  const curatorModel = wantCurate ? resolveCurator(cfg, { sensitive: eff }) : null;
  let packet = null;
  let curatedBy = null;
  if (curatorModel) {
    const curated = await curate(q, ctx, { provider: createProvider(curatorModel, deps), timeoutMs: curatorTimeoutMs });
    if (curated) {
      packet = redactSecrets(curated); // re-scan the curated output (§10: redact twice)
      curatedBy = curatorModel.id;
    }
  }
  if (!packet) packet = buildTemplatePacket(q, ctx);

  // 6. build the advisor prompt (packet wrapped as untrusted DATA) and advise over the chain.
  const prompt = buildAdvisorPrompt(q, packet, { curatedBy });
  const { model, rec, usage } = await adviseWithChain(chain, {
    prompt,
    system: ADVISOR_SYSTEM,
    timeoutMs: advisorTimeoutMs,
    deps,
    parse: (t) => parseRecommendation(t, { panelThreshold: cfg.policy.panel_threshold }),
  });

  if (taskId && state && sig) recordConsult(state, taskId, sig);

  // 7. assemble the StructuredRecommendation with provenance (models used, curated y/n, usage).
  return {
    problem: rec.problem ?? null,
    facts: rec.facts ?? null,
    assumptions: rec.assumptions ?? null,
    recommendation: rec.recommendation,
    why: rec.why ?? null,
    implementation: rec.implementation ?? null,
    alternatives: rec.alternatives ?? null,
    risks: rec.risks ?? null,
    validation: rec.validation ?? null,
    confidence: rec.confidence,
    lowConfidence: rec.lowConfidence,
    warnings: rec.warnings,
    provenance: {
      advisorModel: model.id,
      advisorProvider: model.provider,
      curatorModel: curatedBy,
      curated: Boolean(curatedBy),
      sensitive: eff,
      panelThreshold: cfg.policy.panel_threshold,
      usage: usage ?? null,
    },
  };
}
