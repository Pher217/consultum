// Hand-written types for the published surface. consultum is plain JS; these exist so a TypeScript
// consumer gets the StructuredRecommendation shape without reading the source, and so editors can
// hover-document it for JS consumers too.

export type Trust = 'local' | 'trusted' | 'untrusted';

export type ProviderName =
  | 'anthropic-cli'
  | 'anthropic-api'
  | 'openai'
  | 'openai-compatible'
  | 'ollama'
  | 'codex-cli';

/** Read-only filesystem tools an advisor may opt into. Only ever granted to a `trusted`/`local` model. */
export interface ModelTools {
  /** A subset of `'Read' | 'Grep' | 'Glob'` — shell/mutating tools are rejected at parse time. */
  allow: string[];
  /** Directory scope for the granted tools (required whenever `allow` is non-empty). */
  dirs: string[];
}

export interface ModelSpec {
  provider: ProviderName;
  id: string;
  trust: Trust;
  name?: string;
  baseUrl?: string | null;
  apiKeyEnv?: string | null;
  apiKeyFile?: string | null;
  tokenEnv?: string | null;
  tokenFile?: string | null;
  timeoutMs?: number | null;
  /** Opt-in, directory-scoped read-only tools (anthropic-cli only). null = no tools (the default). */
  tools?: ModelTools | null;
  /** Directory of the config file, stamped by `loadConfig`; credential file paths resolve relative to it. */
  configDir?: string | null;
}

/** Resolved policy. Every field has a default; a config may set any subset. */
export interface Policy {
  default_sensitive: boolean;
  curate: boolean;
  panel_threshold: number;
  panel_auto: boolean;
  max_consults_per_task: number;
  min_attempts_before_debug_consult: number;
  /** Globs; a matching `sourcePath` forces a request sensitive (matched case-insensitively). */
  sensitive_paths: string[];
}

export interface ConsultumConfig {
  path?: string | null;
  /** Directory of the resolved config file (stamped by `loadConfig`). */
  dir?: string;
  models: Record<string, ModelSpec>;
  roles: { advisor: string[]; curator: string | null; panel: string[]; reconciler: string | null };
  policy: Policy;
}

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** One panelist's independent view (spec §8). */
export interface PanelView {
  model: string;
  provider: ProviderName;
  name: string;
  recommendation: string;
  confidence: number;
  risks: string | null;
  warnings: string[];
  usage: Usage | null;
}

/** The reconciler's synthesis over the panel (and the primary advisor) — present only when agreement is 'reconciled'. */
export interface PanelReconciliation {
  recommendation: string;
  dissent: string | null;
  risks: string | null;
  confidence: number;
  warnings: string[];
}

/**
 * Exactly five states, never conflated:
 *   'not-convened'                    - no panel was convened (not requested, or no eligible panelist)
 *   'unassessed'                      - convened, but no reconciler configured — raw views stand
 *   'reconciled'                      - a reconciler actually synthesized the views
 *   'reconciler-failed'               - a reconciler was configured but its pass failed
 *   'reconciler-excluded-sensitive'   - a reconciler is configured but trust policy dropped it
 */
export type PanelAgreement =
  | 'not-convened'
  | 'unassessed'
  | 'reconciled'
  | 'reconciler-failed'
  | 'reconciler-excluded-sensitive';

export interface PanelResult {
  convened: boolean;
  trigger: 'requested' | 'low-confidence';
  /** Explains why no panel was convened / why it produced nothing. Present only on some convened:false branches. */
  reason?: string;
  views: PanelView[];
  failures: string[];
  agreement: PanelAgreement;
  reconciliation: PanelReconciliation | null;
  reconciledBy: string | null;
  /** Model ids the reconciler actually weighed (primary first, then panelists). Only set when agreement is 'reconciled'. */
  reconciledOver?: string[] | null;
  reconcilerError: string | null;
  correlation: string | null;
  /** Per-panelist usage, plus the reconciler's usage when reconciled. Not present on every convened:false branch. */
  usage?: (Usage | null)[];
}

export interface Provenance {
  advisorModel: string;
  advisorProvider: ProviderName;
  /** The curator's model id, or null when the deterministic template packet was used. */
  curatorModel: string | null;
  curated: boolean;
  /**
   * null when curation was never requested. Otherwise explains why it did not happen —
   * e.g. the curator was untrusted for a sensitive request, or it failed.
   */
  curationNote: string | null;
  sensitive: boolean;
  panelThreshold: number;
  usage: Usage | null;
}

/**
 * The advisor's answer. Every prose field is UNTRUSTED model output: schema-validated and linted,
 * never to be executed. `warnings` lists any embedded shell/network commands that were detected.
 */
export interface StructuredRecommendation {
  /** Contract version of this object. Bumped on any breaking field change. */
  schemaVersion: 1;
  problem: string | null;
  facts: string | null;
  assumptions: string | null;
  /** The only always-present prose field — a parse fails without it. */
  recommendation: string;
  why: string | null;
  implementation: string | null;
  alternatives: string | null;
  risks: string | null;
  validation: string | null;
  /** 0-100, self-reported by the advisor. A label, not a measurement. */
  confidence: number;
  lowConfidence: boolean;
  warnings: string[];
  /** null when no panel was convened. */
  panel: PanelResult | null;
  provenance: Provenance;
}

export interface ConsultOptions {
  question: string;
  context?: string;
  /** Escalate-only: may force a request sensitive, can never make a sensitive one non-sensitive. */
  sensitive?: boolean;
  /** Override `policy.curate`. */
  curate?: boolean;
  /**
   * Force a panel (spec §8). HOST-controlled: a panel costs one paid call per panelist, so a
   * tool-loop worker must never be able to trigger that spend itself — see `consultumTool`.
   */
  panel?: boolean;
  /** Host-supplied path used for per-path sensitivity rules. Not worker-controlled. */
  sourcePath?: string | null;
  config?: ConsultumConfig;
  deps?: unknown;
  taskId?: string | null;
  state?: Record<string, unknown> | null;
  advisorTimeoutMs?: number;
  curatorTimeoutMs?: number;
}

/**
 * Run one consult. Never decides — returns a recommendation for the caller to weigh.
 * Throws {@link ConsultumError} rather than silently downgrading a sensitive request.
 */
export function consult(options: ConsultOptions): Promise<StructuredRecommendation>;

export type ErrorKind =
  | 'usage'
  | 'refused-by-policy'
  | 'provider-error'
  | 'limit-exceeded'
  | 'low-confidence'
  | 'malformed-output';

export class ConsultumError extends Error {
  kind: ErrorKind;
  /** The process exit code for this kind (see {@link EXIT}). */
  exitCode: number;
  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown });
  /** The `--json` / shim failure shape. */
  toJSON(): { error: { kind: ErrorKind; message: string } };
}

export const KIND: Record<string, ErrorKind>;

/** Process exit codes: OK 0, USAGE 10, REFUSED_BY_POLICY 11, PROVIDER_ERROR 12, LIMIT_EXCEEDED 13, LOW_CONFIDENCE 14, MALFORMED_OUTPUT 15. */
export const EXIT: Record<string, number>;

export function exitCodeForKind(kind: ErrorKind): number;

/**
 * Discover and load a config. Discovery order: `$CONSULTUM_CONFIG`, then `./consultum.{yaml,yml,json}`,
 * then `$XDG_CONFIG_HOME/consultum/config.*`, then `~/.consultum.*`. Throws {@link ConsultumError}
 * (kind `usage`) if no config is found or it is invalid.
 */
export function loadConfig(options?: {
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  home?: string;
}): ConsultumConfig;
export function parseConfig(yaml: string, filename?: string): ConsultumConfig;

/** Best-effort redaction of common secret shapes. Not a defense against adversarial encoding. */
export function redactSecrets(text: string): string;

/** JSON Schema for the tool-loop shim's `consult_advisor` tool (mirrors {@link consultumTool}). */
export const TOOL_SCHEMA: Record<string, unknown>;

/**
 * args are model-facing (whatever the weak worker sends): `packet` is the field TOOL_SCHEMA
 * actually requires; `context` is accepted as a legacy alias. opts are host-controlled and never
 * settable by the worker (e.g. `panel`, `config`, `sourcePath`).
 */
export function consultumTool(
  args: { question: string; packet?: string; context?: string; sensitive?: boolean },
  opts?: Omit<ConsultOptions, 'question' | 'context'>,
): Promise<
  | ({ ok: true } & StructuredRecommendation)
  | { ok: false; error: { kind: ErrorKind; message: string } }
>;
