// CLI logic, factored out of bin/askup.js so it is unit-testable with injected config/deps/streams.
// Commands: consult | init | doctor | config. The question and context arrive via STDIN, never argv
// (§18/A6). Exit codes are the machine-readable failure semantics from errors.js.

import fs from 'fs';
import path from 'path';
import { consult } from './consult.js';
import { loadConfig, discoverConfigPath, resolveAdvisorChain, resolveCurator } from './config.js';
import { AskupError, KIND, EXIT } from './errors.js';
import { defaultRuntime } from './run.js';

const USAGE = `askup — an advisory channel for delegated AI workers

Usage:
  askup consult [--sensitive] [--curate] [--no-curate] [--json] [--task-id ID] [--config PATH]
                (reads the question + context from STDIN — see below)
  askup init [--print] [--force] [--config PATH]
  askup doctor [--config PATH]
  askup config [--config PATH]

STDIN protocol for 'consult':
  - JSON:  {"question": "...", "context": "..."}
  - or:    the first line is the question, the rest is the context.

Exit codes: 0 ok · 10 usage · 11 refused-by-policy · 12 provider-error · 13 limit-exceeded ·
            14 low-confidence (recommendation still printed) · 15 malformed-advisor-output`;

// ---- arg + stdin parsing ---------------------------------------------------

export function parseArgs(argv) {
  const rest = [...argv];
  // The command is the first token that is not a flag (so `askup --help` has no command).
  const command = rest.length && !rest[0].startsWith('-') ? rest.shift() : undefined;
  const flags = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--sensitive') flags.sensitive = true;
    else if (a === '--curate') flags.curate = true;
    else if (a === '--no-curate') flags.curate = false;
    else if (a === '--json') flags.json = true;
    else if (a === '--print') flags.print = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--task-id') flags.taskId = rest[++i];
    else if (a === '--config') flags.config = rest[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
    else flags._.push(a);
  }
  return { command, flags };
}

export function parseStdin(raw) {
  const text = (raw ?? '').trim();
  if (!text) return { question: '', context: '' };
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      return { question: String(obj.question ?? '').trim(), context: String(obj.context ?? '').trim() };
    } catch {
      // fall through to line-based parsing
    }
  }
  const nl = text.indexOf('\n');
  if (nl === -1) return { question: text, context: '' };
  return { question: text.slice(0, nl).trim(), context: text.slice(nl + 1).trim() };
}

// ---- human formatting ------------------------------------------------------

const SECTION_ORDER = [
  ['problem', 'Problem Assessment'],
  ['facts', 'Verified Facts'],
  ['assumptions', 'Assumptions and Uncertainties'],
  ['recommendation', 'Recommended Approach'],
  ['why', 'Why'],
  ['implementation', 'Implementation Guidance'],
  ['alternatives', 'Alternatives'],
  ['risks', 'Risks'],
  ['validation', 'Validation Plan'],
];

export function formatHuman(rec) {
  const p = rec.provenance;
  const lines = [
    '=== askup recommendation ===',
    `advisor: ${p.advisorModel} (${p.advisorProvider})   curated: ${p.curated ? `yes (${p.curatorModel})` : 'no'}   confidence: ${rec.confidence}/100   sensitive: ${p.sensitive ? 'yes' : 'no'}`,
    '',
  ];
  for (const [key, header] of SECTION_ORDER) {
    if (rec[key]) lines.push(`## ${header}`, rec[key], '');
  }
  if (rec.lowConfidence) {
    lines.push(`(!) low confidence (< ${p.panelThreshold}). Consider a second opinion; the advisor advises — you decide.`, '');
  }
  if (rec.warnings?.length) {
    lines.push('(!) warnings — advice contains possible runnable commands; never pipe to a shell unexamined:');
    for (const w of rec.warnings) lines.push(`    - ${w}`);
    lines.push('');
  }
  if (p.usage) lines.push(`tokens: prompt=${p.usage.promptTokens ?? '?'} completion=${p.usage.completionTokens ?? '?'}`);
  return lines.join('\n').trimEnd();
}

// ---- commands --------------------------------------------------------------

export async function runConsult({ stdin, flags, config, deps = defaultRuntime, out, err }) {
  const { question, context } = parseStdin(stdin);
  if (!question) {
    err(`askup consult: no question on stdin.\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  let cfg = config;
  try {
    cfg = cfg ?? loadConfig({ configPath: flags.config });
  } catch (e) {
    return emitError(e, flags, err);
  }

  // State for library-mode consult limits, only if --task-id is passed.
  let state = null;
  let statePath = null;
  if (flags.taskId) {
    statePath = path.join(process.env.TMPDIR || '/tmp', `askup-state-${sanitize(flags.taskId)}.json`);
    state = readState(statePath);
  }

  try {
    const rec = await consult({
      question,
      context,
      sensitive: Boolean(flags.sensitive),
      curate: flags.curate,
      config: cfg,
      deps,
      taskId: flags.taskId ?? null,
      state,
    });
    if (state && statePath) writeState(statePath, state);
    if (flags.json) out(JSON.stringify(rec, null, 2));
    else out(formatHuman(rec));
    return rec.lowConfidence ? EXIT.LOW_CONFIDENCE : EXIT.OK;
  } catch (e) {
    return emitError(e, flags, err);
  }
}

export async function runConfig({ flags, config, out, err }) {
  let cfg = config;
  try {
    cfg = cfg ?? loadConfig({ configPath: flags.config });
  } catch (e) {
    return emitError(e, flags, err);
  }
  const summary = {
    path: cfg.path ?? '(injected)',
    models: Object.fromEntries(
      Object.entries(cfg.models).map(([n, m]) => [n, { provider: m.provider, id: m.id, trust: m.trust, ...(m.baseUrl ? { base_url: m.baseUrl } : {}) }]),
    ),
    roles: cfg.roles,
    policy: cfg.policy,
  };
  out(JSON.stringify(summary, null, 2));
  return EXIT.OK;
}

export async function runDoctor({ flags, config, out, err, probe = defaultProbe }) {
  let cfg = config;
  try {
    cfg = cfg ?? loadConfig({ configPath: flags.config });
  } catch (e) {
    return emitError(e, flags, err);
  }
  out(`askup doctor — config: ${cfg.path ?? '(injected)'}`);
  out('');
  out('models:');
  for (const [name, m] of Object.entries(cfg.models)) {
    const status = await probe(m);
    out(`  ${name.padEnd(10)} ${m.provider.padEnd(18)} ${m.id.padEnd(22)} trust=${m.trust.padEnd(9)} ${status.reachable ? 'OK' : 'unreachable'}  ${status.detail}`);
  }
  out('');
  out('resolved roles:');
  out(`  advisor (normal):    ${resolveAdvisorChain(cfg, { sensitive: false }).map((m) => m.name).join(' -> ') || '(none)'}`);
  out(`  advisor (sensitive): ${resolveAdvisorChain(cfg, { sensitive: true }).map((m) => m.name).join(' -> ') || '(none — sensitive requests will be REFUSED)'}`);
  const curN = resolveCurator(cfg, { sensitive: false });
  out(`  curator:             ${curN ? curN.name : '(none — deterministic template builder)'}`);
  return EXIT.OK;
}

export function runInit({ flags, out, err, detect = defaultDetect, cwd = process.cwd(), writeFile = fs.writeFileSync, exists = fs.existsSync }) {
  const detected = detect();
  const content = generateStarterConfig(detected);
  if (flags.print) {
    out(content);
    return EXIT.OK;
  }
  const target = flags.config ?? path.join(cwd, 'askup.yaml');
  if (exists(target) && !flags.force) {
    err(`askup init: ${target} already exists. Use --force to overwrite, or --print to preview.`);
    return EXIT.USAGE;
  }
  writeFile(target, content, 'utf8');
  out(`wrote ${target}`);
  out(`detected providers: ${Object.entries(detected).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  out('next: `askup doctor` to verify, then pipe a question into `askup consult`.');
  return EXIT.OK;
}

export function generateStarterConfig(detected) {
  const models = [];
  const advisor = [];
  if (detected.claude) {
    models.push('  opus:  { provider: anthropic-cli, id: claude-opus-4-8, trust: trusted }   # subscription token or ANTHROPIC_API_KEY');
    advisor.push('opus');
  }
  if (detected.codex) {
    models.push('  sol:   { provider: codex-cli,     id: gpt-5.6-sol,     trust: untrusted } # ChatGPT subscription');
    advisor.push('sol');
  }
  if (detected.ollama) {
    models.push('  local: { provider: ollama,        id: gemma3:27b,      trust: local }     # localhost, no key');
    if (advisor.length === 0) advisor.push('local');
  }
  if (models.length === 0) {
    // Nothing detected — emit a commented template the user can fill in.
    models.push('  local: { provider: ollama,        id: gemma3:27b,      trust: local }     # start Ollama, or edit this');
    advisor.push('local');
  }
  return [
    '# askup config. Secrets are NEVER stored here — models reference env vars only.',
    '# Full reference: docs/ · trust: local | trusted | untrusted (sensitive => trusted/local only).',
    'models:',
    ...models,
    'roles:',
    `  advisor: [${advisor.join(', ')}]   # ordered fallback chain — first reachable wins`,
    '  # curator: local              # optional; omit to use the deterministic template builder',
    'policy:',
    '  default_sensitive: false      # sensitive => only trusted/local advisors are eligible',
    '',
  ].join('\n');
}

// ---- helpers ---------------------------------------------------------------

function emitError(e, flags, err) {
  if (e instanceof AskupError) {
    if (flags.json) err(JSON.stringify(e.toJSON()));
    else err(`askup: ${e.kind}: ${e.message}`);
    return e.exitCode;
  }
  if (flags.json) err(JSON.stringify({ error: { kind: 'error', message: e.message } }));
  else err(`askup: error: ${e.message}`);
  return 1;
}

async function defaultProbe(model) {
  // Best-effort reachability check — no model call, no tokens spent.
  try {
    if (model.provider === 'ollama') {
      const base = (model.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
      return { reachable: res.ok, detail: res.ok ? '' : `HTTP ${res.status}` };
    }
    if (model.provider === 'anthropic-cli') return probeOnPath('claude');
    if (model.provider === 'codex-cli') return probeOnPath('codex');
    if (model.provider === 'openai' || model.provider === 'openai-compatible') {
      const env = model.apiKeyEnv || 'OPENAI_API_KEY';
      return { reachable: Boolean(process.env[env]), detail: process.env[env] ? '' : `${env} not set` };
    }
    if (model.provider === 'anthropic-api') {
      const env = model.apiKeyEnv || 'ANTHROPIC_API_KEY';
      return { reachable: Boolean(process.env[env]), detail: process.env[env] ? '' : `${env} not set` };
    }
  } catch (e) {
    return { reachable: false, detail: e.message };
  }
  return { reachable: false, detail: 'unknown provider' };
}

function probeOnPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(d, cmd + ext)).isFile()) return { reachable: true, detail: '' };
      } catch {
        /* keep looking */
      }
    }
  }
  return { reachable: false, detail: `${cmd} not on PATH` };
}

function defaultDetect() {
  return {
    claude: probeOnPath('claude').reachable,
    codex: probeOnPath('codex').reachable,
    ollama: probeOnPath('ollama').reachable,
  };
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_.\-]/g, '_');
}

function readState(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(p, state) {
  try {
    fs.writeFileSync(p, JSON.stringify(state), 'utf8');
  } catch {
    /* best-effort — a missing state file just resets the counter */
  }
}

export { USAGE };
