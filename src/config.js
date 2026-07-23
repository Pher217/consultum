// Config: discovery, parse, validation, env overrides, and role resolution.
//
// Everything consultum does is expressed as ROLES (advisor, curator) mapped to MODEL ENTRIES. A model
// entry declares its provider (adapter), model id, and a user-assigned TRUST class. No model ids
// live in code — they live only in config. Sensitivity FILTERS a role's candidates by trust; there
// are no separate `*_sensitive` roles.

import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { ConsultumError, KIND } from './errors.js';

export const TRUST_VALUES = ['local', 'trusted', 'untrusted'];
// A sensitive request may only reach these trust classes — never a third-party (`untrusted`).
export const SENSITIVE_TRUST = new Set(['local', 'trusted']);

const KNOWN_PROVIDERS = new Set([
  'anthropic-cli',
  'anthropic-api',
  'openai',
  'openai-compatible',
  'ollama',
  'codex-cli',
]);

const POLICY_DEFAULTS = {
  default_sensitive: false,
  curate: false, // curator hop is off by default
  panel_threshold: 70, // confidence below this flags low-confidence (and may auto-convene a panel)
  // Configuring `roles.panel` opts in to a second opinion; this controls whether a LOW-CONFIDENCE
  // answer may convene one AUTOMATICALLY. Auto-firing costs N extra model calls per consult, so it
  // is a separate consent from "a panel exists". Set false to require an explicit --panel.
  panel_auto: true,
  max_consults_per_task: 3, // library mode only (CLI is stateless unless --task-id is passed)
  min_attempts_before_debug_consult: 2,
  sensitive_paths: [], // optional globs; a matching sourcePath forces a request sensitive
};

// Discovery order (highest priority first): $CONSULTUM_CONFIG, then ./consultum.{yaml,yml,json},
// then $XDG_CONFIG_HOME/consultum/config.{yaml,yml,json}, then ~/.consultum.{yaml,yml,json}.
export function candidateConfigPaths({ cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  const paths = [];
  if (env.CONSULTUM_CONFIG) paths.push(env.CONSULTUM_CONFIG);
  const exts = ['yaml', 'yml', 'json'];
  for (const ext of exts) paths.push(path.join(cwd, `consultum.${ext}`));
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  for (const ext of exts) paths.push(path.join(xdg, 'consultum', `config.${ext}`));
  for (const ext of exts) paths.push(path.join(home, `.consultum.${ext}`));
  return paths;
}

export function discoverConfigPath(opts = {}) {
  for (const p of candidateConfigPaths(opts)) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* not found — keep looking */
    }
  }
  return null;
}

// Parse YAML (a JSON superset — .json files parse fine too).
export function parseConfig(text, filename = '<config>') {
  let raw;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new ConsultumError(KIND.USAGE, `could not parse config ${filename}: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConsultumError(KIND.USAGE, `config ${filename} must be a YAML/JSON mapping`);
  }
  return normalizeConfig(raw, filename);
}

// Top-level and per-model-spec keys are validated strictly: an unrecognized key is almost always a
// typo, and silently ignoring it can leave a security-relevant setting (e.g. a mistyped policy key)
// at its default instead of erroring — a fail-open. See KNOWN_MODEL_KEYS below for the model-spec list.
const KNOWN_TOP_LEVEL_KEYS = new Set(['models', 'roles', 'policy']);
const KNOWN_ROLE_KEYS = new Set(['advisor', 'curator', 'panel', 'reconciler']);
const KNOWN_MODEL_KEYS = new Set([
  'provider',
  'id',
  'trust',
  'base_url',
  'baseUrl',
  'api_key_env',
  'apiKeyEnv',
  'api_key_file',
  'apiKeyFile',
  'token_env',
  'tokenEnv',
  'token_file',
  'tokenFile',
  'timeout_ms',
  'timeoutMs',
  'tools',
]);
// Snake_case-only for error messages — keeps the "known keys" list readable while still accepting camelCase.
const KNOWN_MODEL_KEYS_SNAKE = ['provider', 'id', 'trust', 'base_url', 'api_key_env', 'api_key_file', 'token_env', 'token_file', 'timeout_ms', 'tools'];

function normalizeConfig(raw, filename) {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      throw new ConsultumError(
        KIND.USAGE,
        `config ${filename}: unknown top-level key '${key}' (known: ${[...KNOWN_TOP_LEVEL_KEYS].join(', ')})`,
      );
    }
  }
  // Null-prototype: model NAMES are looked up as `models[n]` and `!models[n]` gates "unknown model".
  // With a normal object, `models['toString']` resolves to Object.prototype.toString (truthy), so a
  // `roles.advisor: toString` would pass validation and then crash when resolved. Own-keys only.
  const models = Object.create(null);
  if (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
    throw new ConsultumError(KIND.USAGE, `config ${filename}: 'models' mapping is required`);
  }
  for (const [name, spec] of Object.entries(raw.models)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: model '${name}' must be a mapping`);
    }
    for (const key of Object.keys(spec)) {
      if (!KNOWN_MODEL_KEYS.has(key)) {
        throw new ConsultumError(
          KIND.USAGE,
          `config ${filename}: model '${name}' has unknown key '${key}' (known: ${KNOWN_MODEL_KEYS_SNAKE.join(', ')})`,
        );
      }
    }
    if (!KNOWN_PROVIDERS.has(spec.provider)) {
      throw new ConsultumError(
        KIND.USAGE,
        `config ${filename}: model '${name}' has unknown provider '${spec.provider}' (known: ${[...KNOWN_PROVIDERS].join(', ')})`,
      );
    }
    if (typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: model '${name}' needs a non-empty 'id'`);
    }
    if (!TRUST_VALUES.includes(spec.trust)) {
      throw new ConsultumError(
        KIND.USAGE,
        `config ${filename}: model '${name}' needs trust one of ${TRUST_VALUES.join(' | ')} (got '${spec.trust}')`,
      );
    }
    // Validate the optional fields' TYPES at parse time — otherwise e.g. `base_url: 42` parses fine
    // and only blows up later as an uncaught TypeError (exit 1, outside the contract). Fail here, with
    // a clear usage error, instead.
    const strField = (snake, camel) => {
      const v = spec[snake] ?? spec[camel];
      if (v !== undefined && v !== null && typeof v !== 'string') {
        throw new ConsultumError(KIND.USAGE, `config ${filename}: model '${name}' ${snake} must be a string, got ${JSON.stringify(v)}`);
      }
    };
    strField('base_url', 'baseUrl');
    strField('api_key_env', 'apiKeyEnv');
    strField('api_key_file', 'apiKeyFile');
    strField('token_env', 'tokenEnv');
    strField('token_file', 'tokenFile');
    const timeout = spec.timeout_ms ?? spec.timeoutMs;
    if (timeout !== undefined && timeout !== null && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0)) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: model '${name}' timeout_ms must be a positive integer, got ${JSON.stringify(timeout)}`);
    }
    models[name] = {
      name,
      provider: spec.provider,
      id: spec.id,
      trust: spec.trust,
      baseUrl: spec.base_url ?? spec.baseUrl ?? null,
      apiKeyEnv: spec.api_key_env ?? spec.apiKeyEnv ?? null,
      apiKeyFile: spec.api_key_file ?? spec.apiKeyFile ?? null, // HTTP: file-based key (keychain-free)
      tokenEnv: spec.token_env ?? spec.tokenEnv ?? null, // CLI: env var to inject/read the token from
      tokenFile: spec.token_file ?? spec.tokenFile ?? null, // CLI: file holding the token
      timeoutMs: spec.timeout_ms ?? spec.timeoutMs ?? null,
      // anthropic-cli only: opt-in, directory-scoped tools. Absent => no tools (the safe default).
      tools: normalizeTools(spec.tools, name, filename),
      // directory of the config file — credential file paths resolve relative to it (stamped by loadConfig)
      configDir: null,
    };
  }

  const roles = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  for (const key of Object.keys(roles)) {
    if (!KNOWN_ROLE_KEYS.has(key)) {
      throw new ConsultumError(
        KIND.USAGE,
        `config ${filename}: unknown roles key '${key}' (known: ${[...KNOWN_ROLE_KEYS].join(', ')})`,
      );
    }
  }
  // advisor: string | string[] -> ordered array of model names (the fallback chain).
  const advisorNames = toNameArray(roles.advisor);
  if (advisorNames.length === 0) {
    throw new ConsultumError(KIND.USAGE, `config ${filename}: roles.advisor must name at least one model`);
  }
  for (const n of advisorNames) {
    if (!models[n]) throw new ConsultumError(KIND.USAGE, `config ${filename}: roles.advisor references unknown model '${n}'`);
  }
  // panel: optional ordered list of models convened for a second opinion. Ideally from
  // DIFFERENT provider families — a panel of one family gives correlated answers, which is the
  // opposite of the point. consult() warns when it detects a single-provider panel.
  const panelNames = toNameArray(roles.panel);
  for (const n of panelNames) {
    if (!models[n]) throw new ConsultumError(KIND.USAGE, `config ${filename}: roles.panel references unknown model '${n}'`);
  }
  // reconciler: optional single model that SYNTHESIZES the panel's views. Omit it and consultum returns
  // the raw views with dissent surfaced — it will NOT fake an agreement verdict (free-text agreement
  // detection is not deterministic).
  let reconcilerName = null;
  if (roles.reconciler !== undefined && roles.reconciler !== null) {
    if (typeof roles.reconciler !== 'string') {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: roles.reconciler must be a single model name or omitted`);
    }
    if (!models[roles.reconciler]) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: roles.reconciler references unknown model '${roles.reconciler}'`);
    }
    reconcilerName = roles.reconciler;
  }

  // curator: optional single model name (omit -> deterministic template packet builder).
  let curatorName = null;
  if (roles.curator !== undefined && roles.curator !== null) {
    if (typeof roles.curator !== 'string') {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: roles.curator must be a single model name or omitted`);
    }
    if (!models[roles.curator]) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: roles.curator references unknown model '${roles.curator}'`);
    }
    curatorName = roles.curator;
  }

  const policy = { ...POLICY_DEFAULTS };
  if (raw.policy !== undefined) {
    if (typeof raw.policy !== 'object' || raw.policy === null || Array.isArray(raw.policy)) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: 'policy' must be a mapping`);
    }
    for (const key of Object.keys(raw.policy)) {
      // Object.hasOwn, NOT `key in POLICY_DEFAULTS`: `in` walks the prototype chain, so keys like
      // `toString`/`constructor`/`valueOf` would pass as "known" and then crash validatePolicyValue
      // (a config could turn a clean usage error into an uncaught TypeError). Own-keys only.
      if (!Object.hasOwn(POLICY_DEFAULTS, key)) {
        throw new ConsultumError(
          KIND.USAGE,
          `config ${filename}: unknown policy key '${key}' (known: ${Object.keys(POLICY_DEFAULTS).join(', ')})`,
        );
      }
      policy[key] = validatePolicyValue(key, raw.policy[key], filename);
    }
  }

  return { models, roles: { advisor: advisorNames, curator: curatorName, panel: panelNames, reconciler: reconcilerName }, policy };
}

// Strict policy validation. A mistyped policy value must be a config error, never silently coerced —
// e.g. `default_sensitive: "true"` (a string) would otherwise be truthy in config but fail the
// `=== true` check in isSensitive(), leaving an untrusted advisor eligible (a fail-open). Reported by
// review.
const BOOL_POLICY = new Set(['default_sensitive', 'curate', 'panel_auto']);
const INT_POLICY = {
  panel_threshold: [0, 100],
  max_consults_per_task: [1, Number.MAX_SAFE_INTEGER],
  min_attempts_before_debug_consult: [0, Number.MAX_SAFE_INTEGER],
};

function validatePolicyValue(key, value, filename) {
  if (BOOL_POLICY.has(key)) {
    if (typeof value !== 'boolean') {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: policy.${key} must be a boolean, got ${JSON.stringify(value)}`);
    }
    return value;
  }
  if (Object.hasOwn(INT_POLICY, key)) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: policy.${key} must be an integer, got ${JSON.stringify(value)}`);
    }
    const [min, max] = INT_POLICY[key];
    if (value < min || value > max) {
      throw new ConsultumError(KIND.USAGE, `config ${filename}: policy.${key} must be in [${min}, ${max}], got ${value}`);
    }
    return value;
  }
  // sensitive_paths
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new ConsultumError(KIND.USAGE, `config ${filename}: policy.sensitive_paths must be a list of strings`);
  }
  return value;
}

// Only these read-only filesystem tools may ever be opted into. Shell/network/mutating tools (Bash,
// Write, Edit, WebFetch, WebSearch, …) are rejected outright — granting Bash would make the directory
// scope meaningless. Even these read tools do NOT constitute a security
// boundary (an advisor with Read can disclose files); they are an explicit, narrow opt-in.
const ALLOWED_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function normalizeTools(tools, name, filename) {
  if (tools === undefined || tools === null) return null;
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    throw new ConsultumError(KIND.USAGE, `config ${filename}: model '${name}' tools must be a mapping { allow: [...], dirs: [...] }`);
  }
  for (const key of Object.keys(tools)) {
    if (key !== 'allow' && key !== 'dirs') {
      throw new ConsultumError(
        KIND.USAGE,
        `config ${filename}: model '${name}' tools has unknown key '${key}' (known: allow, dirs)`,
      );
    }
  }
  const allow = Array.isArray(tools.allow) ? tools.allow.map(String) : [];
  const dirs = Array.isArray(tools.dirs) ? tools.dirs.map(String) : [];
  for (const t of allow) {
    if (!ALLOWED_TOOLS.has(t)) {
      throw new ConsultumError(
        KIND.USAGE,
        `config ${filename}: model '${name}' tool '${t}' is not permitted — only read-only filesystem tools (${[...ALLOWED_TOOLS].join(', ')}) may be granted`,
      );
    }
  }
  if (allow.length > 0 && dirs.length === 0) {
    // filesystem tools are opt-in AND directory-scoped. Refuse tools without a scope.
    throw new ConsultumError(
      KIND.USAGE,
      `config ${filename}: model '${name}' grants tools (${allow.join(',')}) but no 'dirs' scope — directory scope is required`,
    );
  }
  return { allow, dirs };
}

function toNameArray(v) {
  if (v === undefined || v === null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.map(String);
  return [];
}

// CONSULTUM_MODEL_<NAME>_ID / _BASE_URL override the config (12-factor / CI). Secrets are never here —
// only the id and endpoint. NAME is the model key uppercased with non-alphanumerics as underscores.
export function applyEnvOverrides(config, env = process.env) {
  for (const [name, model] of Object.entries(config.models)) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const id = env[`CONSULTUM_MODEL_${key}_ID`];
    if (id) model.id = id;
    const baseUrl = env[`CONSULTUM_MODEL_${key}_BASE_URL`];
    if (baseUrl) model.baseUrl = baseUrl;
  }
  return config;
}

export function loadConfig({ cwd, env = process.env, home, configPath } = {}) {
  const resolved = configPath ?? discoverConfigPath({ cwd, env, home });
  if (!resolved) {
    throw new ConsultumError(
      KIND.USAGE,
      'no consultum config found. Run `consultum init` to scaffold one (searched ./consultum.yaml, $XDG_CONFIG_HOME/consultum/config.yaml, ~/.consultum.yaml).',
    );
  }
  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ConsultumError(KIND.USAGE, `could not read config ${resolved}: ${err.message}`);
  }
  const config = parseConfig(text, resolved);
  applyEnvOverrides(config, env);
  config.path = resolved;
  config.dir = path.dirname(resolved);
  for (const m of Object.values(config.models)) m.configDir = config.dir; // credential paths resolve here
  return config;
}

// Decide sensitivity. Config-level default and per-path rules set the baseline; the --sensitive
// flag may only ESCALATE (true wins), never de-escalate.
export function isSensitive(config, { flagSensitive = false, sourcePath = null } = {}) {
  if (config.policy.default_sensitive === true) return true;
  if (flagSensitive === true) return true;
  if (sourcePath && matchesSensitivePath(config.policy.sensitive_paths, sourcePath)) return true;
  return false;
}

function matchesSensitivePath(globs, sourcePath) {
  // Normalize Windows separators and a leading ./ so patterns behave the same cross-platform.
  const norm = String(sourcePath).replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some((g) => globToRegExp(g).test(norm));
}

// Minimal glob: `*` matches a run of non-slash chars; `**/` matches zero or more path segments (so
// `**/secrets/**` matches both `secrets/x` at the root AND `a/b/secrets/x`); a trailing `**` matches
// anything. Anchored full-match.
function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/');
  let re = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') {
        re += '(?:[^/]*/)*'; // zero or more leading segments, including none
        i += 2;
      } else {
        re += '.*';
        i++;
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  // Case-INSENSITIVE: this drives a security control (sensitive-path routing). On Windows paths are
  // case-insensitive, so a case-sensitive match would let `App\Secrets\db.txt` slip past a
  // `**/secrets/**` rule and route sensitive data to an untrusted advisor — a fail-open. Matching
  // case-insensitively fails CLOSED (it can only over-flag as sensitive, never under-flag), which is
  // the safe direction for this control.
  return new RegExp(re + '$', 'i');
}

// Ordered advisor fallback chain for this request. When sensitive, drop untrusted (third-party)
// candidates. May return [] — the caller turns that into a REFUSED_BY_POLICY for a sensitive request.
export function resolveAdvisorChain(config, { sensitive = false } = {}) {
  const chain = config.roles.advisor.map((n) => config.models[n]);
  if (!sensitive) return chain;
  return chain.filter((m) => SENSITIVE_TRUST.has(m.trust));
}

// Panel members eligible for this request, trust-filtered exactly like the advisor chain. May return
// [] (no panel configured, or every panelist is untrusted on a sensitive request) — the caller then
// simply doesn't convene one; a panel is never a hard requirement.
// A panel fans out to one PAID call per panelist, so its size is a spend multiplier. Cap it: a
// misconfigured (or hostile) config listing dozens of panelists would otherwise turn a single
// consult into dozens of billed requests.
export const MAX_PANELISTS = 5;

export function resolvePanel(config, { sensitive = false } = {}) {
  const panel = (config.roles.panel || []).map((n) => config.models[n]);
  const eligible = sensitive ? panel.filter((m) => SENSITIVE_TRUST.has(m.trust)) : panel;
  return eligible.slice(0, MAX_PANELISTS);
}

// The reconciler model, or null. Sensitivity filters it like everything else: an untrusted reconciler
// is dropped on a sensitive request (its input is the panel's full recommendations).
export function resolveReconciler(config, { sensitive = false } = {}) {
  if (!config.roles.reconciler) return null;
  const m = config.models[config.roles.reconciler];
  if (sensitive && !SENSITIVE_TRUST.has(m.trust)) return null;
  return m;
}

// The curator model for this request, or null (=> deterministic template packet). A sensitive
// request drops an untrusted curator (fail-closed): the raw redacted packet goes straight to advise.
export function resolveCurator(config, { sensitive = false } = {}) {
  if (!config.roles.curator) return null;
  const m = config.models[config.roles.curator];
  if (sensitive && !SENSITIVE_TRUST.has(m.trust)) return null;
  return m;
}
