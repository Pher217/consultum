// Best-effort secret redaction before any cross-model send (defence in depth — the caller is also
// expected to redact). Ported from a hardened production implementation.
//
// SCOPE (see docs/threat-model.md, A4): this is best-effort against *accidental* leakage, NOT
// adversarial encoding. base64/rot/split encodings defeat every regex. Sensitive workloads must be
// marked sensitive (config-level) so they never reach a third-party provider at all — redaction is
// not the control that protects deliberately-hidden secrets.
//
// Strategy: match assignments whose KEY name CONTAINS a secret-indicating word, so conventional env
// vars (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, OPENAI_API_KEY, DB_PASSWORD) are covered — not just an
// exact allowlist. Plus unlabeled-shape patterns (PEM blocks, provider key prefixes, JWTs, DSNs,
// Bearer tokens). Over-redaction is the safe failure mode here.

export const SECRET_KEY_WORD =
  'TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|SESSION|COOKIE|BEARER|DATABASE_URL|DB_URL';

// Redact + trim + take the last n chars — for embedding a subprocess's stderr (or an HTTP error
// body) into an AskupError message without leaking a token that appeared there.
export function redactedTail(text, n = 200) {
  return redactSecrets(String(text ?? '').trim()).slice(-n);
}

export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  // KEY = <rest of line> where the KEY name contains a secret-indicating word (case-insensitive).
  out = out.replace(
    new RegExp(`(["']?[A-Za-z0-9_.\\-]*(?:${SECRET_KEY_WORD})[A-Za-z0-9_.\\-]*["']?\\s*[:=]\\s*)[^\\n]+`, 'gi'),
    '$1[REDACTED]',
  );
  // Standalone Bearer <token> not preceded by a key.
  out = out.replace(/\b(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1[REDACTED]');
  // Unlabeled secrets by shape (best-effort — not a substitute for not including them).
  out = out.replace(/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]');
  out = out.replace(/\b(?:ghp_|gho_|ghs_|github_pat_|xox[abpr]-|sk-|AKIA|ASIA)[A-Za-z0-9_\-]{10,}/g, '[REDACTED]'); // PATs / API keys / AWS
  out = out.replace(/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, '[REDACTED JWT]'); // JWTs
  out = out.replace(/\b[a-z][a-z0-9+.\-]*:\/\/[^\s/@]+:[^\s/@]+@\S+/gi, '[REDACTED DSN]'); // scheme://user:pass@host DSNs
  return out;
}
