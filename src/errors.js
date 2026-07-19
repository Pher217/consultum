// Machine-readable failure semantics. Every askup failure carries a `kind` (stable string) and a
// process exit code, so a calling script — or a tool loop — can branch on the outcome without
// parsing prose. Codes start at 10 to stay clear of Node's own 1 (uncaught) / and the shell's
// reserved range.

export const KIND = {
  USAGE: 'usage', // bad CLI args, missing/malformed config
  REFUSED_BY_POLICY: 'refused-by-policy', // sensitive request, no eligible (trusted/local) advisor
  PROVIDER_ERROR: 'provider-error', // every advisor in the chain failed (down/stalled/empty)
  LIMIT_EXCEEDED: 'limit-exceeded', // consult limit or dedup guard tripped (library mode)
  LOW_CONFIDENCE: 'low-confidence', // a recommendation was returned, but below panel_threshold
  MALFORMED_OUTPUT: 'malformed-output', // advisor output failed the parse contract after one retry
};

const KIND_TO_EXIT = {
  [KIND.USAGE]: 10,
  [KIND.REFUSED_BY_POLICY]: 11,
  [KIND.PROVIDER_ERROR]: 12,
  [KIND.LIMIT_EXCEEDED]: 13,
  [KIND.LOW_CONFIDENCE]: 14,
  [KIND.MALFORMED_OUTPUT]: 15,
};

export const EXIT = {
  OK: 0,
  USAGE: 10,
  REFUSED_BY_POLICY: 11,
  PROVIDER_ERROR: 12,
  LIMIT_EXCEEDED: 13,
  LOW_CONFIDENCE: 14,
  MALFORMED_OUTPUT: 15,
};

export function exitCodeForKind(kind) {
  return KIND_TO_EXIT[kind] ?? 1;
}

export class AskupError extends Error {
  constructor(kind, message, { cause } = {}) {
    super(message);
    this.name = 'AskupError';
    this.kind = kind;
    this.exitCode = exitCodeForKind(kind);
    if (cause !== undefined) this.cause = cause;
  }

  // Shape used by `--json` on failure and by the tool-loop shim.
  toJSON() {
    return { error: { kind: this.kind, message: this.message } };
  }
}
