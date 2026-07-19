// The Curator role: compress a weak worker's rough material into a tight, fact-vs-assumption packet
// so the expensive advisor spends its tokens reasoning, not parsing. Two ways to build the packet:
//   - curate():             a high-context, cheap curator MODEL structures the material (best result)
//   - buildTemplatePacket(): a DETERMINISTIC template with no model call, so the packet format is real
//                            even when no curator is configured, on a sensitive run, or if curation fails.

import { CURATOR_SYSTEM, buildCuratorUserPrompt } from './prompts.js';

// Deterministic, no-model packet. Honest about the fact that facts and assumptions are not separated.
export function buildTemplatePacket(question, context) {
  const ctx = (context || '').trim() || '(no additional context was provided)';
  return [
    '# Advisory Request',
    '',
    '## Question',
    (question || '').trim() || '(no question was provided)',
    '',
    '## Context (verbatim from the executor)',
    ctx,
    '',
    '## Notes',
    'Assembled by askup’s deterministic template builder — no curator model was used. Verified facts',
    'and assumptions are NOT separated here; the advisor should treat unlabeled context with caution.',
  ].join('\n');
}

// Run the curator model over the raw material. Returns the curated packet text, or null on any
// failure (empty output, provider error, timeout) so the caller can fall back to the template.
export async function curate(question, context, { provider, timeoutMs } = {}) {
  const user = buildCuratorUserPrompt(question, context);
  try {
    const { text } = await provider.invoke(user, { system: CURATOR_SYSTEM, timeoutMs });
    const t = (text || '').trim();
    return t || null;
  } catch {
    return null;
  }
}
