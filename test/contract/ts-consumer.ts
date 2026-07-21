// Compile-only fixture: proves the PUBLISHED types/index.d.ts (as shipped in the packed tarball,
// resolved here via node_modules/consultum in the throwaway install dir) type-check a realistic
// consumer under --strict. This file is never executed — pack-contract.mjs only runs `tsc --noEmit`
// over it. It must never import from the source repo; only from the installed package name.
import { consult, consultumTool, loadConfig, type StructuredRecommendation } from 'consultum';

async function useConsult(): Promise<void> {
  const rec: StructuredRecommendation = await consult({
    question: 'should we retry?',
    context: 'attempt 1 failed with ECONNRESET',
    panel: true,
  });
  const panel = rec.panel;
  if (panel) {
    const _views = panel.views.map((v) => v.recommendation);
  }
  const confidence: number = rec.confidence;
  console.log(confidence);
}

async function useConsultumTool(): Promise<void> {
  const result = await consultumTool({
    question: 'is this approach safe?',
    packet: 'facts: ...\nquestion: is this approach safe?',
    sensitive: true,
  });
  if (result.ok === false) {
    const kind: string = result.error.kind;
    console.log(kind);
    return;
  }
  const confidence: number = result.confidence;
  console.log(confidence);
}

function useLoadConfig(): void {
  const cfg = loadConfig();
  const panelRoles: string[] = cfg.roles.panel;
  console.log(panelRoles);
}

// Deliberately never invoked: this file exists to be type-checked (`tsc --noEmit`), not executed.
// `node --test`'s default file discovery sweeps up any file under a directory named `test` —
// including this one — and would execute it as a plain module; `loadConfig()`/`consult()` calls at
// module scope would then throw for real (no config, no reachable provider) outside the contract
// harness. Referencing the functions without calling them still gives tsc full type coverage.
export { useConsult, useConsultumTool, useLoadConfig };
