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

export interface ModelSpec {
  provider: ProviderName;
  id: string;
  trust: Trust;
  name?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  tokenEnv?: string;
  tokenFile?: string;
  timeoutMs?: number;
}

export interface ConsultumConfig {
  path?: string | null;
  models: Record<string, ModelSpec>;
  roles: { advisor: string[]; curator?: string };
  policy: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number | null;
  completionTokens: number | null;
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
  provenance: Provenance;
}

export interface ConsultOptions {
  question: string;
  context?: string;
  /** Escalate-only: may force a request sensitive, can never make a sensitive one non-sensitive. */
  sensitive?: boolean;
  /** Override `policy.curate`. */
  curate?: boolean;
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
  constructor(kind: ErrorKind, message: string, options?: { cause?: unknown });
}

export const KIND: Record<string, ErrorKind>;

/** Process exit codes: OK 0, USAGE 10, REFUSED_BY_POLICY 11, PROVIDER_ERROR 12, LIMIT_EXCEEDED 13, LOW_CONFIDENCE 14, MALFORMED_OUTPUT 15. */
export const EXIT: Record<string, number>;

export function exitCodeForKind(kind: ErrorKind): number;

export function loadConfig(options?: { configPath?: string }): ConsultumConfig;
export function parseConfig(yaml: string, filename?: string): ConsultumConfig;

/** Best-effort redaction of common secret shapes. Not a defense against adversarial encoding. */
export function redactSecrets(text: string): string;

/** JSON Schema for the tool-loop shim's `consult` tool. */
export const TOOL_SCHEMA: Record<string, unknown>;

export function consultumTool(
  args: { question: string; context?: string },
  opts?: Omit<ConsultOptions, 'question' | 'context'>,
): Promise<{ ok: true; recommendation: StructuredRecommendation } | { ok: false; error: string }>;
