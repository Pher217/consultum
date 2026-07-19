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
  { name: 'command-substitution', re: /\$\([^)]+\)|`[^`]+`/ },
];

// Scan EVERY returned field — a command hidden in an unscanned section (e.g. Risks) would otherwise
// reach the weak executor with no warning (Sol finding 5).
const SCANNED_FIELDS = ['problem', 'facts', 'assumptions', 'recommendation', 'why', 'implementation', 'alternatives', 'risks', 'validation'];

export function lintGuidance(rec) {
  const haystack = SCANNED_FIELDS.map((f) => rec[f]).filter(Boolean).join('\n');
  const warnings = [];
  for (const { name, re } of LINT_PATTERNS) {
    if (re.test(haystack)) warnings.push(`advice contains a possible shell/network command (${name}) — review before running, never pipe to a shell unexamined`);
  }
  return warnings;
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
  for (const line of lines) {
    const m = line.match(/^\s{0,3}(#{1,6}|\*\*)\s*(.+?)\s*(\*\*)?\s*:?\s*$/);
    if (m) {
      const key = headerToKey(m[2].replace(/\*\*/g, ''));
      flush();
      currentKey = key; // may be null (unrecognized header) — its body is dropped
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
  const confText = sections.confidence;
  const confMatch = confText && confText.match(/\d{1,3}/);
  if (!confMatch) {
    throw new AskupError(KIND.MALFORMED_OUTPUT, 'advisor output missing a parseable "Confidence" (0-100) value');
  }
  rec.confidence = Math.max(0, Math.min(100, parseInt(confMatch[0], 10)));
  rec.lowConfidence = rec.confidence < panelThreshold;
  rec.warnings = lintGuidance(rec);
  return rec;
}
