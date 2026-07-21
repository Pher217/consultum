// Compile-time regression fixture for the published `types/index.d.ts`. Never executed — `npm run
// typecheck` (wired into `npm test`) just runs `tsc --noEmit --strict` over this file. If a
// declaration goes stale relative to the runtime (src/shim.js, src/consult.js, src/config.js), this
// file fails to compile.

import { consult, consultumTool, loadConfig, PanelAgreement } from '../types/index.js';

function exerciseConfigRoles(): void {
  // src/config.js:172 — roles always has all four keys; `panel` is a string[], `reconciler` and
  // `curator` are `string | null` (never `undefined` — the field is present, just possibly null).
  const cfg = loadConfig();
  const panelNames: string[] = cfg.roles.panel;
  const reconcilerName: string | null = cfg.roles.reconciler;
  const curatorName: string | null = cfg.roles.curator;
  console.log(panelNames.length, reconcilerName, curatorName);
}

async function exercisePanel(): Promise<void> {
  const rec = await consult({ question: 'q', context: 'c', panel: true });

  // StructuredRecommendation.panel is PanelResult | null — the runtime spreads it at
  // src/consult.js:268 as a full object with `agreement` a 5-state union (src/consult.js:198-205).
  if (rec.panel) {
    const agreement: PanelAgreement = rec.panel.agreement;
    console.log(agreement, rec.panel.convened, rec.panel.trigger, rec.panel.views.length, rec.panel.failures.length);
    console.log(rec.panel.reconciledBy, rec.panel.reconciledOver, rec.panel.reconcilerError, rec.panel.correlation, rec.panel.usage);
    if (rec.panel.reconciliation) {
      console.log(rec.panel.reconciliation.recommendation, rec.panel.reconciliation.dissent);
    }
  }
}

async function exerciseTool(): Promise<void> {
  // args must accept `packet` (the field TOOL_SCHEMA actually requires, src/shim.js:33) plus
  // `sensitive` (src/shim.js:46) — not just { question, context }.
  const result = await consultumTool(
    { question: 'q', packet: 'factual packet', sensitive: true },
    { panel: true },
  );

  if (result.ok) {
    // SUCCESS is a SPREAD at the top level (src/shim.js:57 `{ ok: true, ...rec }`) — `recommendation`
    // here is the recommendation STRING field, not a nested StructuredRecommendation object.
    const recommendationText: string = result.recommendation;
    console.log(recommendationText, result.schemaVersion, result.confidence, result.panel);
  } else {
    // ERROR is a structured object (src/errors.js ConsultumError#toJSON, via src/shim.js:59-60),
    // never a bare string.
    console.log(result.error.kind, result.error.message);
  }
}

exerciseConfigRoles();
void exercisePanel();
void exerciseTool();
