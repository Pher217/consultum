// Config: discovery, parse, validation, env overrides, and role resolution.
//
// Everything askup does is expressed as ROLES (advisor, curator) mapped to MODEL ENTRIES. A model
// entry declares its provider (adapter), model id, and a user-assigned TRUST class. No model ids
// live in code — they live only in config. Sensitivity FILTERS a role's candidates by trust; there
// are no separate `*_sensitive` roles (Fable review §18).

import fs from 'fs';
import os from 'os';
import path from 'path';
import YAML from 'yaml';
import { AskupError, KIND } from './errors.js';

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
  curate: false, // curator hop is off by default in v0.1 (§18: optional, off by default)
  panel_threshold: 70, // confidence below this flags low-confidence (panel itself is v0.2)
  max_consults_per_task: 3, // library mode only (CLI is stateless unless --task-id is passed)
  min_attempts_before_debug_consult: 2,
  sensitive_paths: [], // optional globs; a matching sourcePath forces a request sensitive
};

// Discovery order (highest priority first): $ASKUP_CONFIG, then ./askup.{yaml,yml,json},
// then $XDG_CONFIG_HOME/askup/config.{yaml,yml,json}, then ~/.askup.{yaml,yml,json}.
export function candidateConfigPaths({ cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  const paths = [];
  if (env.ASKUP_CONFIG) paths.push(env.ASKUP_CONFIG);
  const exts = ['yaml', 'yml', 'json'];
  for (const ext of exts) paths.push(path.join(cwd, `askup.${ext}`));
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  for (const ext of exts) paths.push(path.join(xdg, 'askup', `config.${ext}`));
  for (const ext of exts) paths.push(path.join(home, `.askup.${ext}`));
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
    throw new AskupError(KIND.USAGE, `could not parse config ${filename}: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AskupError(KIND.USAGE, `config ${filename} must be a YAML/JSON mapping`);
  }
  return normalizeConfig(raw, filename);
}

function normalizeConfig(raw, filename) {
  const models = {};
  if (!raw.models || typeof raw.models !== 'object' || Array.isArray(raw.models)) {
    throw new AskupError(KIND.USAGE, `config ${filename}: 'models' mapping is required`);
  }
  for (const [name, spec] of Object.entries(raw.models)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new AskupError(KIND.USAGE, `config ${filename}: model '${name}' must be a mapping`);
    }
    if (!KNOWN_PROVIDERS.has(spec.provider)) {
      throw new AskupError(
        KIND.USAGE,
        `config ${filename}: model '${name}' has unknown provider '${spec.provider}' (known: ${[...KNOWN_PROVIDERS].join(', ')})`,
      );
    }
    if (typeof spec.id !== 'string' || !spec.id.trim()) {
      throw new AskupError(KIND.USAGE, `config ${filename}: model '${name}' needs a non-empty 'id'`);
    }
    if (!TRUST_VALUES.includes(spec.trust)) {
      throw new AskupError(
        KIND.USAGE,
        `config ${filename}: model '${name}' needs trust one of ${TRUST_VALUES.join(' | ')} (got '${spec.trust}')`,
      );
    }
    models[name] = {
      name,
      provider: spec.provider,
      id: spec.id,
      trust: spec.trust,
      baseUrl: spec.base_url ?? spec.baseUrl ?? null,
      apiKeyEnv: spec.api_key_env ?? spec.apiKeyEnv ?? null,
      timeoutMs: spec.timeout_ms ?? spec.timeoutMs ?? null,
      // anthropic-cli only: opt-in, directory-scoped tools. Absent => no tools (the safe default).
      tools: normalizeTools(spec.tools, name, filename),
    };
  }

  const roles = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  // advisor: string | string[] -> ordered array of model names (the fallback chain).
  const advisorNames = toNameArray(roles.advisor);
  if (advisorNames.length === 0) {
    throw new AskupError(KIND.USAGE, `config ${filename}: roles.advisor must name at least one model`);
  }
  for (const n of advisorNames) {
    if (!models[n]) throw new AskupError(KIND.USAGE, `config ${filename}: roles.advisor references unknown model '${n}'`);
  }
  // curator: optional single model name (omit -> deterministic template packet builder).
  let curatorName = null;
  if (roles.curator !== undefined && roles.curator !== null) {
    if (typeof roles.curator !== 'string') {
      throw new AskupError(KIND.USAGE, `config ${filename}: roles.curator must be a single model name or omitted`);
    }
    if (!models[roles.curator]) {
      throw new AskupError(KIND.USAGE, `config ${filename}: roles.curator references unknown model '${roles.curator}'`);
    }
    curatorName = roles.curator;
  }

  const policy = { ...POLICY_DEFAULTS };
  if (raw.policy && typeof raw.policy === 'object' && !Array.isArray(raw.policy)) {
    for (const key of Object.keys(POLICY_DEFAULTS)) {
      if (raw.policy[key] !== undefined) policy[key] = raw.policy[key];
    }
  }
  if (!Array.isArray(policy.sensitive_paths)) {
    throw new AskupError(KIND.USAGE, `config ${filename}: policy.sensitive_paths must be a list`);
  }

  return { models, roles: { advisor: advisorNames, curator: curatorName }, policy };
}

function normalizeTools(tools, name, filename) {
  if (tools === undefined || tools === null) return null;
  if (typeof tools !== 'object' || Array.isArray(tools)) {
    throw new AskupError(KIND.USAGE, `config ${filename}: model '${name}' tools must be a mapping { allow: [...], dirs: [...] }`);
  }
  const allow = Array.isArray(tools.allow) ? tools.allow.map(String) : [];
  const dirs = Array.isArray(tools.dirs) ? tools.dirs.map(String) : [];
  if (allow.length > 0 && dirs.length === 0) {
    // Fable §18: filesystem tools are opt-in AND directory-scoped. Refuse tools without a scope.
    throw new AskupError(
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

// ASKUP_MODEL_<NAME>_ID / _BASE_URL override the config (12-factor / CI). Secrets are never here —
// only the id and endpoint. NAME is the model key uppercased with non-alphanumerics as underscores.
export function applyEnvOverrides(config, env = process.env) {
  for (const [name, model] of Object.entries(config.models)) {
    const key = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const id = env[`ASKUP_MODEL_${key}_ID`];
    if (id) model.id = id;
    const baseUrl = env[`ASKUP_MODEL_${key}_BASE_URL`];
    if (baseUrl) model.baseUrl = baseUrl;
  }
  return config;
}

export function loadConfig({ cwd, env = process.env, home, configPath } = {}) {
  const resolved = configPath ?? discoverConfigPath({ cwd, env, home });
  if (!resolved) {
    throw new AskupError(
      KIND.USAGE,
      'no askup config found. Run `askup init` to scaffold one (searched ./askup.yaml, $XDG_CONFIG_HOME/askup/config.yaml, ~/.askup.yaml).',
    );
  }
  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new AskupError(KIND.USAGE, `could not read config ${resolved}: ${err.message}`);
  }
  const config = parseConfig(text, resolved);
  applyEnvOverrides(config, env);
  config.path = resolved;
  return config;
}

// Decide sensitivity. Config-level default and per-path rules set the baseline; the --sensitive
// flag may only ESCALATE (true wins), never de-escalate (§18: fail-closed, weak executor can't relax it).
export function isSensitive(config, { flagSensitive = false, sourcePath = null } = {}) {
  if (config.policy.default_sensitive === true) return true;
  if (flagSensitive === true) return true;
  if (sourcePath && matchesSensitivePath(config.policy.sensitive_paths, sourcePath)) return true;
  return false;
}

function matchesSensitivePath(globs, sourcePath) {
  return globs.some((g) => globToRegExp(g).test(sourcePath));
}

// Minimal glob: * matches any run of non-slash chars, ** matches across slashes. Anchored full-match.
function globToRegExp(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re + '$');
}

// Ordered advisor fallback chain for this request. When sensitive, drop untrusted (third-party)
// candidates. May return [] — the caller turns that into a REFUSED_BY_POLICY for a sensitive request.
export function resolveAdvisorChain(config, { sensitive = false } = {}) {
  const chain = config.roles.advisor.map((n) => config.models[n]);
  if (!sensitive) return chain;
  return chain.filter((m) => SENSITIVE_TRUST.has(m.trust));
}

// The curator model for this request, or null (=> deterministic template packet). A sensitive
// request drops an untrusted curator (fail-closed): the raw redacted packet goes straight to advise.
export function resolveCurator(config, { sensitive = false } = {}) {
  if (!config.roles.curator) return null;
  const m = config.models[config.roles.curator];
  if (sensitive && !SENSITIVE_TRUST.has(m.trust)) return null;
  return m;
}
