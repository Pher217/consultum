// consult() — the whole channel in one function:
//   redact → decide sensitivity → (limit check) → curate|template → redact again → wrap as DATA →
//   advise over the fallback chain (retry-once on malformed) → schema-validate + lint → provenance.
//
// It NEVER decides. It returns a StructuredRecommendation (with a confidence and any lint warnings);
// the caller stays the decision-owner. It refuses (throws) rather than silently downgrading a
// sensitive request to a third-party advisor.

import { loadConfig, isSensitive, resolveAdvisorChain, resolveCurator, resolvePanel, resolveReconciler } from './config.js';
import { convenePanel, reconcile, correlationWarning } from './panel.js';
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
  panel = false,
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
  // Distinguish "curation was never asked for" from "curation was asked for and did not happen".
  // Falling back to the template is correct, but doing it invisibly contradicts this module's own
  // rule of never silently downgrading — a user who configured a curator deserves to know it was
  // skipped (untrusted for a sensitive request) or that it failed.
  let curationNote = null;
  if (wantCurate && !curatorModel) {
    curationNote = eff
      ? 'curator skipped: configured curator is untrusted and this request is sensitive'
      : 'curator skipped: no curator resolved';
  }
  if (curatorModel) {
    const curated = await curate(q, ctx, { provider: createProvider(curatorModel, deps), timeoutMs: curatorTimeoutMs });
    if (curated) {
      packet = redactSecrets(curated); // re-scan the curated output (redact twice)
      curatedBy = curatorModel.id;
    } else {
      curationNote = `curator ${curatorModel.id} failed or returned nothing — used the deterministic template instead`;
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

  // 6b. Panel (spec §8). Convened when the caller forces it, or when the advisor self-reports low
  // confidence AND a panel is configured. Self-reported confidence is a labeled heuristic, not a
  // measurement — `--panel` is the reliable trigger. A panel is never required: if none is
  // configured/eligible, the primary recommendation stands unchanged.
  let panelResult = null;
  // Exclude the model that already answered — asking it again adds no independence. Identity is
  // (provider, id), NOT id alone: the same id on a different provider is a genuinely different
  // advisor and must stay on the panel (caught live — an openai-compatible panelist sharing an id
  // with the ollama advisor was being dropped silently).
  const key = (m) => `${m.provider} ${m.id}`;
  const seen = new Set([key(model)]);
  const panelists = resolvePanel(cfg, { sensitive: eff }).filter((m) => {
    if (seen.has(key(m))) return false; // also dedupes duplicate panel entries
    seen.add(key(m));
    return true;
  });
  const autoAllowed = cfg.policy.panel_auto !== false;
  const wantPanel = Boolean(panel) || (rec.lowConfidence && autoAllowed);

  // An explicitly requested panel that yields no eligible panelists must SAY so — silently returning
  // no panel after the caller asked for one hides a policy refusal.
  if (panel && panelists.length === 0) {
    panelResult = {
      convened: false,
      trigger: 'requested',
      reason: eff
        ? 'no eligible panelist: every configured panelist is untrusted and this request is sensitive'
        : 'no eligible panelist configured (roles.panel is empty, or only names the primary advisor)',
      views: [],
      failures: [],
      agreement: 'not-convened',
      reconciliation: null,
      reconciledBy: null,
      reconcilerError: null,
      correlation: null,
    };
  }
  if (wantPanel && panelists.length > 0) {
   try {
    const { views, failures } = await convenePanel(panelists, {
      prompt,
      system: ADVISOR_SYSTEM,
      timeoutMs: advisorTimeoutMs,
      deps,
      parse: (t) => parseRecommendation(t, { panelThreshold: cfg.policy.panel_threshold }),
    });
    // A reconciler configured but dropped for trust is NOT the same as "none configured" — the CLI
    // must not claim the latter when policy refused the former.
    const reconciler = resolveReconciler(cfg, { sensitive: eff });
    const reconcilerExcluded = Boolean(cfg.roles.reconciler) && !reconciler;
    const synth = await reconcile(reconciler, {
      question: q,
      views,
      // The primary advisor's answer is part of what gets reconciled — it is the opinion that
      // triggered the panel. Reconciling only the panelists would make "reconciled" overstate
      // what actually happened.
      primary: {
        model: model.id,
        provider: model.provider,
        recommendation: rec.recommendation,
        confidence: rec.confidence,
        risks: rec.risks ?? null,
      },
      timeoutMs: advisorTimeoutMs,
      deps,
      parse: (t) => parseRecommendation(t, { panelThreshold: cfg.policy.panel_threshold }),
    });
    panelResult = {
      convened: true,
      trigger: panel ? 'requested' : 'low-confidence',
      views,
      failures,
      // Three DISTINCT states, never conflated:
      //   'unassessed'        - no reconciler configured; askup does NOT guess whether views agree
      //                         (spec §18: free-text agreement detection is not deterministic)
      //   'reconciled'        - a reconciler actually synthesized them
      //   'reconciler-failed' - one was configured but failed; the views still stand
      //   'reconciler-excluded-sensitive' - one IS configured but policy dropped it (trust filter)
      agreement:
        synth.status === 'reconciled'
          ? 'reconciled'
          : synth.status === 'failed'
            ? 'reconciler-failed'
            : reconcilerExcluded
              ? 'reconciler-excluded-sensitive'
              : 'unassessed',
      // The reconciler is INSTRUCTED to put material disagreement in Alternatives and to lower its
      // confidence when views diverge. Keeping only `recommendation` would amputate exactly the
      // dissent channel the synthesis exists to produce, rendering disagreement as clean consensus.
      reconciliation: synth.status === 'reconciled'
        ? {
            recommendation: synth.rec.recommendation,
            dissent: synth.rec.alternatives ?? null,
            risks: synth.rec.risks ?? null,
            confidence: synth.rec.confidence,
            warnings: synth.rec.warnings ?? [],
          }
        : null,
      reconciledBy: synth.status === 'reconciled' ? synth.model : null,
      // Auditable: exactly which opinions the synthesis weighed (primary first, then panelists).
      reconciledOver: synth.status === 'reconciled' ? synth.over : null,
      reconcilerError: synth.status === 'failed' ? `${synth.model}: ${synth.error}` : null,
      correlation: correlationWarning([{ provider: model.provider }, ...views]),
      usage: views.map((v) => v.usage ?? null).concat(synth.usage ?? null),
    };
   } catch (err) {
    // The primary recommendation is already paid for and valid. A misconfigured PANEL must not
    // destroy it on the auto path — the caller never asked for a panel there. An explicitly
    // requested panel still fails loud, because the caller asked for exactly that.
    if (panel) throw err;
    panelResult = {
      convened: false,
      trigger: 'low-confidence',
      reason: `panel skipped — ${err.message}`,
      views: [],
      failures: [err.message],
      agreement: 'not-convened',
      reconciliation: null,
      reconciledBy: null,
      reconcilerError: null,
      correlation: null,
    };
   }
  }

  if (taskId && state && sig) recordConsult(state, taskId, sig);

  // 7. assemble the StructuredRecommendation with provenance (models used, curated y/n, usage).
  return {
    // Machine consumers (the tool-loop shim, the --json CLI contract, any language wrapper) parse
    // this object. Versioning it from the first release means a later field change is a negotiable
    // migration rather than a silent break; adding the field afterwards would itself be the break.
    schemaVersion: 1,
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
    // null when no panel was convened. When present, every panelist view is visible and `agreement`
    // is 'unassessed' unless a reconciler actually synthesized them — askup does not guess consensus.
    panel: panelResult,
    provenance: {
      advisorModel: model.id,
      advisorProvider: model.provider,
      curatorModel: curatedBy,
      curated: Boolean(curatedBy),
      // null when curation was never requested; otherwise says why it did not happen.
      curationNote,
      sensitive: eff,
      panelThreshold: cfg.policy.panel_threshold,
      usage: usage ?? null,
    },
  };
}
