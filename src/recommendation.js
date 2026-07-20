// The advisor's returned recommendation is UNTRUSTED input aimed at the weakest model in the system
// (threat-model A3). Two defenses live here:
//   1. A deterministic PARSE CONTRACT: the output must contain the required labeled sections, or it
//      is malformed (the caller retries once, then errors). Free text that does not parse is rejected.
//   2. A LINT that flags embedded shell/network commands in the guidance, surfaced as warnings so a
//      caller (and a human) can see "this advice contains a runnable command" before acting on it.
// The hard rule (docs): implementation guidance is never piped to a shell unexamined.

import { AskupError, KIND } from './errors.js';
import { ADVISOR_SECTIONS } from './prompts.js';

// A few tolerant aliases for the two required headers (models paraphrase).
const HEADER_ALIASES = {
  recommendation: ['recommended approach', 'recommendation', 'recommended solution'],
  confidence: ['confidence', 'confidence (0-100)', 'confidence score'],
};

function headerToKey(rawHeader) {
  const norm = rawHeader.trim().replace(/:$/, '').toLowerCase();
  for (const s of ADVISOR_SECTIONS) {
    if (s.header.toLowerCase() === norm) return s.key;
  }
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(norm)) return key;
  }
  return null;
}

// Patterns that indicate a runnable shell / network / interpreter command embedded in advice.
const LINT_PATTERNS = [
  { name: 'curl', re: /\bcurl\b/i },
  { name: 'wget', re: /\bwget\b/i },
  { name: 'pipe-to-shell', re: /\|\s*(sh|bash|zsh|python[0-9.]*|node|perl|ruby)\b/i },
  { name: 'shell-eval', re: /\b(sh|bash|zsh)\s+-c\b/i },
  { name: 'interpreter-eval', re: /\b(python[0-9.]*\s+-c|node\s+-e|perl\s+-e|ruby\s+-e)\b/i },
  { name: 'eval', re: /\beval\b/i },
  { name: 'rm -rf', re: /\brm\s+-rf\b/i },
  { name: 'chmod', re: /\bchmod\s+\+x\b/i },
  { name: 'netcat', re: /\bnc\s+-/i },
  { name: 'ssh', re: /\bssh\s+\S/i },
  { name: 'scp', re: /\bscp\s+\S/i },
  { name: 'base64-decode', re: /\bbase64\s+(-d|--decode)\b/i },
  { name: 'powershell', re: /\b(powershell|pwsh|iex|Invoke-Expression|iwr|irm|Invoke-WebRequest)\b/i },
  // Only REAL command substitution. A previous version also flagged any `backtick span`, which fires
  // on ordinary prose ("set it in `config.js`, then run `npm test`") — i.e. on essentially every
  // technical answer. A warning that is always on is a warning nobody reads, which would quietly
  // disable the one signal threat-model A3 depends on. Dangerous content INSIDE backticks is still
  // caught: every other pattern scans the same text regardless of markdown formatting.
  { name: 'command-substitution', re: /\$\([^)]+\)/ },
];

// Scan EVERY returned field — a command hidden in an unscanned section (e.g. Risks) would otherwise
// reach the weak executor with no warning.
const SCANNED_FIELDS = ['problem', 'facts', 'assumptions', 'recommendation', 'why', 'implementation', 'alternatives', 'risks', 'validation'];

export function lintGuidance(rec) {
  const haystack = SCANNED_FIELDS.map((f) => rec[f]).filter(Boolean).join('\n');
  const warnings = [];
  for (const { name, re } of LINT_PATTERNS) {
    if (re.test(haystack)) warnings.push(`advice contains a possible shell/network command (${name}) — review before running, never pipe to a shell unexamined`);
  }
  return warnings;
}

// Extract a 0-100 confidence. Returns null when nothing parseable is present.
//
// This used to be `match(/\d{1,3}/)` — the FIRST digit run anywhere in the section — which read
// "On a 0-100 scale, 85" as 0 and "7 out of 10" as 7. That is not cosmetic: confidence drives
// `lowConfidence`, exit code 14, and (with a panel configured) whether extra paid advisors are
// convened. A misparse silently changes control flow and spend, so the explicit forms are matched
// first and the bare-number fallback takes the LAST number rather than the first.
export function parseConfidence(text) {
  if (!text) return null;
  const clamp = (n) => Math.max(0, Math.min(100, n));

  const outOf100 = text.match(/(\d{1,3})\s*(?:\/|\s+out\s+of\s+)\s*100\b/i);
  if (outOf100) return clamp(parseInt(outOf100[1], 10));

  // "7 out of 10" / "7/10" is a 0-10 scale — rescale rather than reporting 7.
  const outOf10 = text.match(/(\d{1,2})(?:\.\d+)?\s*(?:\/|\s+out\s+of\s+)\s*10\b/i);
  if (outOf10) return clamp(parseInt(outOf10[1], 10) * 10);

  const pct = text.match(/(\d{1,3})\s*%/);
  if (pct) return clamp(parseInt(pct[1], 10));

  // Fallback: the LAST standalone integer. Prose like "on a 0-100 scale, 85" states the scale
  // before the value, so the first number is systematically the wrong one.
  const all = [...text.matchAll(/(?:^|[^\d.])(\d{1,3})(?![\d.])/g)];
  if (all.length) return clamp(parseInt(all[all.length - 1][1], 10));

  return null;
}

// Parse advisor text into the structured recommendation. Throws MALFORMED_OUTPUT when the parse
// contract is not met (required sections missing / confidence unparseable).
export function parseRecommendation(text, { panelThreshold = 70 } = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new AskupError(KIND.MALFORMED_OUTPUT, 'advisor returned empty output');
  }
  const lines = text.split('\n');
  const sections = {};
  let currentKey = null;
  let buf = [];
  const flush = () => {
    if (currentKey && buf.length) sections[currentKey] = (sections[currentKey] ? sections[currentKey] + '\n' : '') + buf.join('\n').trim();
    buf = [];
  };
  // Header detection is deliberately CONSERVATIVE. The old regex treated any line starting with `**`
  // as a header, so a routine bold lead-in ("**Note:** also do X.") was read as an unrecognized
  // header and every following line of that section was silently discarded — the advisor's answer
  // arrived truncated with no error. Models emit bold lead-ins constantly. Silent loss is the worst
  // failure mode here, so anything not clearly a section header is treated as CONTENT.
  let inFence = false;
  for (const line of lines) {
    // Inside a fenced code block nothing is a header: shell comments (`# install deps`) would
    // otherwise fragment the section around them.
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (currentKey) buf.push(line);
      continue;
    }
    if (inFence) {
      if (currentKey) buf.push(line);
      continue;
    }

    const hashed = line.match(/^\s{0,3}(#{1,6})\s*(.+?)\s*:?\s*$/);
    // A bold line counts as a header ONLY if the whole line is the bold span (plus optional colon).
    const bolded = line.match(/^\s{0,3}\*\*\s*([^*]+?)\s*\*\*\s*:?\s*$/);

    if (hashed) {
      const key = headerToKey(hashed[2]);
      if (key || hashed[1].length <= 2) {
        // A recognized header, or an unrecognized top-level (#/##) one: a real section boundary.
        // An unrecognized boundary sets currentKey = null, so its body is dropped by contract.
        flush();
        currentKey = key;
      } else if (currentKey) {
        // `###`+ that maps to nothing is a SUB-heading inside the current section, not a new
        // section — keep it and everything under it.
        buf.push(line);
      }
    } else if (bolded) {
      const key = headerToKey(bolded[1]);
      if (key) {
        flush();
        currentKey = key;
      } else if (currentKey) {
        buf.push(line);
      }
    } else if (currentKey) {
      buf.push(line);
    }
  }
  flush();

  const rec = {};
  for (const s of ADVISOR_SECTIONS) {
    if (s.key === 'confidence') continue;
    if (sections[s.key]) rec[s.key] = sections[s.key].trim();
  }

  if (!rec.recommendation) {
    throw new AskupError(KIND.MALFORMED_OUTPUT, 'advisor output missing required "Recommended Approach" section');
  }
  const confidence = parseConfidence(sections.confidence);
  if (confidence === null) {
    throw new AskupError(KIND.MALFORMED_OUTPUT, 'advisor output missing a parseable "Confidence" (0-100) value');
  }
  rec.confidence = confidence;
  rec.lowConfidence = rec.confidence < panelThreshold;
  rec.warnings = lintGuidance(rec);
  return rec;
}
