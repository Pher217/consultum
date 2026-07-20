// The escalation ladder for v0.1 is an ORDERED AVAILABILITY FALLBACK CHAIN (not a panel — panels are
// v0.2). Try each advisor in order; a provider that errors or stalls falls through to the next. For a
// reachable advisor whose output does not meet the parse contract, retry ONCE with a corrective nudge,
// then treat it as failed and fall through. This ports the Codex "fail-fast-on-stall, then fall back"
// guardrail into the adapter contract.

import { createProvider } from './providers/index.js';
import { ConsultumError, KIND } from './errors.js';

const RETRY_NUDGE =
  '\n\nNOTE: your previous response did not follow the required format. Respond again using EXACTLY ' +
  'the markdown section headers you were given. You MUST include "## Recommended Approach" and, at the ' +
  'end, "## Confidence" followed by a single integer 0-100.';

// chain: ordered array of model entries. Returns { model, rec, text, usage }. Throws when the whole
// chain is exhausted — PROVIDER_ERROR if nobody answered, MALFORMED_OUTPUT if answers never parsed.
export async function adviseWithChain(chain, { prompt, system, timeoutMs, deps, parse }) {
  const providerErrors = [];
  const malformedErrors = [];

  for (const model of chain) {
    const provider = createProvider(model, deps);

    let first;
    try {
      first = await provider.invoke(prompt, { system, timeoutMs });
    } catch (err) {
      // A credential/config error (USAGE) is the user's to fix — fail loud, do not silently try the
      // next advisor with (e.g.) a bad-perms token file.
      if (err instanceof ConsultumError && err.kind === KIND.USAGE) throw err;
      providerErrors.push(`${model.name}: ${err.message}`);
      continue; // provider down/stalled/empty → next advisor
    }

    try {
      const rec = parse(first.text);
      return { model, rec, text: first.text, usage: first.usage };
    } catch (err) {
      if (err.kind !== KIND.MALFORMED_OUTPUT) throw err;
      // retry once with the same advisor and a corrective nudge
      try {
        const second = await provider.invoke(prompt + RETRY_NUDGE, { system, timeoutMs });
        const rec = parse(second.text);
        return { model, rec, text: second.text, usage: second.usage };
      } catch (err2) {
        if (err2 instanceof ConsultumError && err2.kind === KIND.USAGE) throw err2; // config/credential error — fail loud (mirror the first-invoke path)
        if (err2.kind === KIND.MALFORMED_OUTPUT) {
          malformedErrors.push(`${model.name}: ${err2.message}`);
          continue; // still malformed after retry → next advisor
        }
        providerErrors.push(`${model.name}: ${err2.message}`); // provider died on retry
        continue;
      }
    }
  }

  if (malformedErrors.length && !providerErrors.length) {
    throw new ConsultumError(
      KIND.MALFORMED_OUTPUT,
      `every advisor produced unparseable output after one retry: ${malformedErrors.join(' | ')}`,
    );
  }
  throw new ConsultumError(
    KIND.PROVIDER_ERROR,
    `no advisor in the chain was reachable: ${[...providerErrors, ...malformedErrors].join(' | ')}`,
  );
}
