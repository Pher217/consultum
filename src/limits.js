// Consultation limits — loop & cost control. These are LIBRARY-MODE ONLY: the CLI is stateless, so
// they apply only when a caller threads a `taskId` and a `state` object (the CLI does so when
// --task-id is passed, persisting `state` to a JSON file). Without state there is nothing to count.
//
// NOTE: `min_attempts_before_debug_consult` is ADVISORY — it is documented guidance (docs/
// when-to-consult.md) that the executor honors, not something the library can enforce (consultum does not
// see the executor's attempt count). It is exposed in config so callers can read and apply it.

import { createHash } from 'crypto';
import { ConsultumError, KIND } from './errors.js';

const SEP = '\u0000'; // NUL separator, written as an ASCII escape so this file stays text: a raw NUL
// byte makes git classify the source as binary and hides its diff from review entirely.

// A stable signature of a consult's EXACT content, for the re-consult dedup guard. The NUL separator
// makes ("a","bc") and ("ab","c") produce different signatures. This is an exact-content hash, NOT a
// fuzzy/semantic match: a genuinely reworded re-consult with new evidence is allowed through by design.
export function consultSignature(question, context) {
  return createHash('sha256').update(`${question}${SEP}${context}`).digest('hex').slice(0, 16);
}

// Throw LIMIT_EXCEEDED if this task has hit its consult cap or is re-asking the exact same thing.
// Call before consulting.
export function checkConsultLimit(state, taskId, sig, policy) {
  // Array.isArray guard, NOT `state[taskId] || []`: a prototype key (`--task-id toString`) makes
  // `state['toString']` the inherited function, and a corrupt state file can put any type here —
  // either way `.includes`/`.length` would throw. A non-array entry is treated as "no prior consults".
  const prior = Array.isArray(state[taskId]) ? state[taskId] : [];
  if (prior.length >= policy.max_consults_per_task) {
    throw new ConsultumError(
      KIND.LIMIT_EXCEEDED,
      `max_consults_per_task (${policy.max_consults_per_task}) reached for task '${taskId}'`,
    );
  }
  if (prior.includes(sig)) {
    throw new ConsultumError(
      KIND.LIMIT_EXCEEDED,
      `re-consult with identical content for task '${taskId}' — add new evidence (a test result, error, or discovery) before consulting again`,
    );
  }
}

export function recordConsult(state, taskId, sig) {
  // Reset to a fresh array if the slot is not already one (prototype key or corrupt entry) — `??=`
  // alone would keep an inherited function and then throw on .push.
  if (!Array.isArray(state[taskId])) state[taskId] = [];
  state[taskId].push(sig);
}
