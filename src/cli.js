// CLI logic, factored out of bin/askup.js so it is unit-testable with injected config/deps/streams.
// Commands: consult | init | doctor | config. The question and context arrive via STDIN, never
// argv (argv leaks to `ps`). Exit codes are the machine-readable failure semantics from errors.js.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { consult } from './consult.js';
import { loadConfig, discoverConfigPath, resolveAdvisorChain, resolveCurator, TRUST_VALUES } from './config.js';
import { AskupError, KIND, EXIT } from './errors.js';
import { defaultRuntime } from './run.js';

const USAGE = `askup — an advisory channel for delegated AI workers

Usage:
  askup consult [--sensitive] [--panel] [--curate|--no-curate] [--json] [--task-id ID]
                [--source-path PATH] [--config PATH]
                (reads the question + context from STDIN — see below)

  askup init [--interactive] [--print] [--force] [--sandbox] [--config PATH]
  askup doctor [--config PATH]
  askup config [--config PATH]

--panel: ask every model in roles.panel the same question concurrently and show each view.
  Costs one extra model call PER PANELIST, plus the reconciler if configured. It also fires
  automatically on a low-confidence answer when a panel is configured — set
  policy.panel_auto: false to require an explicit --panel.

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
    else if (a === '--panel') flags.panel = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--print') flags.print = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--sandbox') flags.sandbox = true;
    else if (a === '--interactive' || a === '-i') flags.interactive = true;
    else if (a === '--task-id') flags.taskId = rest[++i];
    else if (a === '--source-path') flags.sourcePath = rest[++i];
    else if (a === '--config') flags.config = rest[++i];
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else flags._.push(a);
  }
  return { command, flags };
}

export function parseStdin(raw) {
  const text = (raw ?? '').trim();
  if (!text) return { question: '', context: '', sourcePath: null };
  if (text.startsWith('{')) {
    try {
      const obj = JSON.parse(text);
      return {
        question: String(obj.question ?? '').trim(),
        context: String(obj.context ?? '').trim(),
        sourcePath: obj.sourcePath ? String(obj.sourcePath) : null,
      };
    } catch {
      // fall through to line-based parsing
    }
  }
  const nl = text.indexOf('\n');
  if (nl === -1) return { question: text, context: '', sourcePath: null };
  return { question: text.slice(0, nl).trim(), context: text.slice(nl + 1).trim(), sourcePath: null };
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
  if (rec.panel) {
    const pn = rec.panel;
    if (!pn.convened) {
      lines.push(`## Panel — NOT convened (${pn.trigger})`, `(!) ${pn.reason}`, '');
    } else {
      lines.push(`## Panel (${pn.views.length} advisor${pn.views.length === 1 ? '' : 's'}, ${pn.trigger})`, '');
      for (const v of pn.views) {
        lines.push(`### ${v.model} — confidence ${v.confidence}`, v.recommendation, '');
        // Panel views are model output shown to the reader — they get the same runnable-command
        // lint treatment as the primary recommendation, or a command could slip through unflagged.
        for (const w of v.warnings ?? []) lines.push(`    (!) ${w}`);
        if (v.warnings?.length) lines.push('');
      }
      if (pn.agreement === 'reconciled') {
        const r = pn.reconciliation;
        lines.push(
          `### Reconciled by ${pn.reconciledBy} — confidence ${r.confidence}`,
          `(over: ${(pn.reconciledOver || []).join(', ')})`,
          r.recommendation,
          '',
        );
        // The dissent is the whole point of a reconciliation; never drop it.
        if (r.dissent) lines.push('#### Dissent / alternatives across advisors', r.dissent, '');
        if (r.risks) lines.push('#### Risks (reconciled)', r.risks, '');
        for (const w of r.warnings ?? []) lines.push(`    (!) ${w}`);
        if (r.warnings?.length) lines.push('');
      } else if (pn.agreement === 'reconciler-failed') {
        lines.push(`(!) reconciler FAILED (${pn.reconcilerError}) — views are NOT assessed for agreement.`, '    Fix the reconciler or read the views and decide.', '');
      } else if (pn.agreement === 'reconciler-excluded-sensitive') {
        lines.push('(!) a reconciler IS configured but was excluded: this request is sensitive and the', '    reconciler is untrusted. Views are NOT assessed for agreement.', '');
      } else {
        lines.push('(i) No reconciler configured — the views above are NOT assessed for agreement.', '    askup will not guess whether they agree; read them and decide.', '');
      }
      if (pn.correlation) lines.push(`(!) ${pn.correlation}`, '');
      if (pn.failures?.length) {
        lines.push('(!) panelists that failed:');
        for (const f of pn.failures) lines.push(`    - ${f}`);
        lines.push('');
      }
    }
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
  const { question, context, sourcePath: stdinSourcePath } = parseStdin(stdin);
  // --source-path (host-supplied) wins; a JSON stdin sourcePath is a fallback. Either way sensitivity
  // is escalate-only, so a caller-provided path can only ADD sensitivity, never relax it.
  const sourcePath = flags.sourcePath ?? stdinSourcePath ?? null;
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
    // os.tmpdir() honors TMPDIR/TEMP/TMP per platform; the old `TMPDIR || '/tmp'` wrote to a
    // literal `\tmp` on Windows, where TMPDIR is not set.
    statePath = path.join(os.tmpdir(), `askup-state-${sanitize(flags.taskId)}.json`);
    state = readState(statePath);
  }

  try {
    const rec = await consult({
      question,
      context,
      sensitive: Boolean(flags.sensitive),
      sourcePath,
      curate: flags.curate,
      panel: Boolean(flags.panel),
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
  const statusByName = {};
  let sawEgressBlock = false;
  let sawMissingModel = false;
  for (const [name, m] of Object.entries(cfg.models)) {
    const s = await probe(m);
    statusByName[name] = s;
    if (s.status === 'egress-blocked') sawEgressBlock = true;
    if (s.status === 'model-missing') sawMissingModel = true;
    out(`  ${name.padEnd(10)} ${m.provider.padEnd(18)} ${m.id.padEnd(22)} trust=${m.trust.padEnd(9)} ${String(s.status).padEnd(14)} ${s.detail || ''}`);
  }
  if (sawEgressBlock) {
    out('');
    out('  (!) egress-blocked: a host was unreachable. If you are inside a sandbox, network egress may');
    out('      be off — prefer the HTTP adapters and see docs/sandboxed-callers.md.');
  }
  if (sawMissingModel) {
    out('');
    out('  (!) model-missing: the host is up but that model is not pulled. Run the `ollama pull`');
    out('      shown above, or point the config at a tag you already have (`ollama list`).');
  }
  out('');
  out('resolved roles:');
  const normalChain = resolveAdvisorChain(cfg, { sensitive: false });
  out(`  advisor (normal):    ${normalChain.map((m) => m.name).join(' -> ') || '(none)'}`);
  out(`  advisor (sensitive): ${resolveAdvisorChain(cfg, { sensitive: true }).map((m) => m.name).join(' -> ') || '(none — sensitive requests will be REFUSED)'}`);
  const curN = resolveCurator(cfg, { sensitive: false });
  out(`  curator:             ${curN ? curN.name : '(none — deterministic template builder)'}`);

  // Exit non-zero when no advisor in the normal chain is usable (reachable + locally authed), so a
  // wrapper/CI can detect a broken setup. This is distinct from a sensitive-policy refusal.
  const usable = normalChain.some((m) => statusByName[m.name]?.status === 'ok');
  if (!usable) {
    out('');
    out('  (!) no usable advisor in the normal chain — fix auth/egress above before consulting.');
    return EXIT.PROVIDER_ERROR;
  }
  return EXIT.OK;
}

// The interactive wizard writes the SAME YAML schema `init` already produces — it just fills the
// values in instead of leaving a template to hand-edit. Deliberately a terminal flow, not a local
// web UI: askup's primary caller is an automated worker running headless, in a sandbox, over SSH or
// in CI, where a browser wizard is unreachable — and standing up an HTTP listener that renders API
// keys would add a real attack surface (DNS rebinding / CSRF against localhost) to a tool whose
// whole job is handling secrets carefully. See docs/architecture.md.
export async function runInitInteractive({ flags, out, err, detect = defaultDetect, ask, cwd = process.cwd(), writeFile = fs.writeFileSync, exists = fs.existsSync, mkdir = fs.mkdirSync }) {
  const detected = detect();
  out('askup init — interactive. Enter to accept the [default]; Ctrl-C to abort.');
  out(`detected on PATH: ${Object.entries(detected).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  out('');

  const models = [];
  const advisor = [];

  const addModel = async (key, label, provider, defaultId, trust, hint) => {
    const yes = await ask(`Configure ${label}? [Y/n] `);
    if (/^n/i.test(yes.trim())) return;
    const id = (await ask(`  model id for ${label} [${defaultId}]: `)).trim() || defaultId;
    const t = (await ask(`  trust for ${label} — local|trusted|untrusted [${trust}]: `)).trim() || trust;
    if (!TRUST_VALUES.includes(t)) {
      err(`  '${t}' is not a valid trust value; using '${trust}'.`);
    }
    const useTrust = TRUST_VALUES.includes(t) ? t : trust;
    models.push(`  ${key}: { provider: ${provider}, id: ${id}, trust: ${useTrust} }${hint ? `  # ${hint}` : ''}`);
    advisor.push(key);
  };

  if (detected.claude) await addModel('claude', 'Claude Code CLI', 'anthropic-cli', 'claude-opus-4-8', 'trusted', 'uses the CLI login');
  if (detected.codex) await addModel('codex', 'Codex CLI', 'codex-cli', 'gpt-5-codex', 'untrusted', 'read-capable agent, NOT no-tools');
  if (detected.ollama) await addModel('local', 'Ollama (local)', 'ollama', 'llama3.1:8b', 'local', 'localhost, no key');
  if (!models.length) {
    out('Nothing detected — adding an Ollama entry you can edit.');
    models.push('  local: { provider: ollama, id: llama3.1:8b, trust: local }');
    advisor.push('local');
  }

  const curator = (await ask(`Curator model (compresses context before the advisor) — a model key, or blank for none [none]: `)).trim();
  const sens = await ask('Treat every request as sensitive by default (third-party advisors refused)? [y/N] ');

  const content = [
    '# askup config. Secrets are NEVER stored here — models reference env vars only.',
    '# `askup doctor` verifies each model is reachable and (for Ollama) actually pulled.',
    '# trust: local | trusted | untrusted (sensitive => trusted/local only).',
    'models:',
    ...models,
    'roles:',
    `  advisor: [${advisor.join(', ')}]   # ordered fallback chain — first reachable wins`,
    curator && advisor.includes(curator) ? `  curator: ${curator}` : '  # curator: <model key>   # optional; omit to use the deterministic template builder',
    'policy:',
    `  default_sensitive: ${/^y/i.test(sens.trim()) ? 'true' : 'false'}`,
    '',
  ].join('\n');

  if (curator && !advisor.includes(curator)) {
    err(`note: '${curator}' is not one of the models you configured — leaving the curator commented out.`);
  }

  const target = flags.config ?? path.join(cwd, 'askup.yaml');
  if (exists(target) && !flags.force) {
    err(`askup init: ${target} already exists. Use --force to overwrite.`);
    return EXIT.USAGE;
  }
  mkdir(path.dirname(target), { recursive: true });
  writeFile(target, content, 'utf8');
  out('');
  out(`wrote ${target}`);
  out('next: `askup doctor` to verify, then pipe a question into `askup consult`.');
  return EXIT.OK;
}

export function runInit({ flags, out, err, detect = defaultDetect, cwd = process.cwd(), writeFile = fs.writeFileSync, exists = fs.existsSync, mkdir = fs.mkdirSync }) {
  const detected = detect();
  const content = generateStarterConfig(detected, { sandbox: Boolean(flags.sandbox) });
  if (flags.print) {
    out(content);
    return EXIT.OK;
  }
  // The sandbox preset must NOT default into the worker-writable cwd (threat-model A7). Default it to
  // the user config dir instead; a non-sandbox init still uses ./askup.yaml.
  const defaultTarget = flags.sandbox
    ? path.join(xdgConfigHome(), 'askup', 'config.yaml')
    : path.join(cwd, 'askup.yaml');
  const target = flags.config ?? defaultTarget;
  if (exists(target) && !flags.force) {
    err(`askup init: ${target} already exists. Use --force to overwrite, or --print to preview.`);
    return EXIT.USAGE;
  }
  mkdir(path.dirname(target), { recursive: true }); // create ~/.config/askup etc. so the write succeeds
  writeFile(target, content, 'utf8');
  out(`wrote ${target}`);
  if (flags.sandbox) {
    out('sandbox preset: HTTP adapters only (no keychain, no bundled CLI). Set OPENAI_API_KEY /');
    out('ANTHROPIC_API_KEY (or api_key_file), and allowlist egress to api.openai.com / api.anthropic.com.');
    out('IMPORTANT: keep this config OUTSIDE any worker-writable dir — set ASKUP_CONFIG to a path a');
    out('worker cannot write (threat-model A7). See docs/sandboxed-callers.md.');
  } else {
    out(`detected providers: ${Object.entries(detected).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'}`);
  }
  out('next: `askup doctor` to verify, then pipe a question into `askup consult`.');
  return EXIT.OK;
}

export function generateStarterConfig(detected, { sandbox = false } = {}) {
  if (sandbox) return sandboxStarterConfig();
  const models = [];
  const advisor = [];
  if (detected.claude) {
    models.push('  claude: { provider: anthropic-cli, id: claude-opus-4-8, trust: trusted }   # uses the Claude Code login, or ANTHROPIC_API_KEY');
    advisor.push('claude');
  }
  if (detected.codex) {
    models.push('  codex:  { provider: codex-cli,     id: gpt-5-codex,      trust: untrusted } # read-capable agent, NOT a no-tools advisor (docs/threat-model.md)');
    advisor.push('codex');
  }
  if (detected.ollama) {
    models.push('  local:  { provider: ollama,        id: llama3.1:8b,      trust: local }     # localhost, no key');
    if (advisor.length === 0) advisor.push('local');
  }
  if (models.length === 0) {
    // Nothing detected — emit a commented template the user can fill in.
    models.push('  local:  { provider: ollama,        id: llama3.1:8b,      trust: local }     # start Ollama, or edit this');
    advisor.push('local');
  }
  return [
    '# askup config. Secrets are NEVER stored here — models reference env vars only.',
    '# Model ids below are EXAMPLES — change them to models you actually have.',
    '# `askup doctor` tells you which are reachable and (for Ollama) actually pulled.',
    '# Reference: https://github.com/Pher217/askup#docs',
    '# trust: local | trusted | untrusted (sensitive => trusted/local only).',
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

// For a caller inside a restricted sandbox: HTTP adapters only — they need just an env/file key and
// one allowlisted host, never the OS keychain or a bundled CLI (docs/sandboxed-callers.md).
function sandboxStarterConfig() {
  return [
    '# askup — sandbox preset. HTTP adapters only (keychain-free, one host each).',
    '# Keys come from env vars (or api_key_file). Keep THIS FILE outside any worker-writable dir',
    '# and point ASKUP_CONFIG at it (threat-model A7). trust: local | trusted | untrusted.',
    'models:',
    '  claude: { provider: anthropic-api, id: claude-opus-4-8, trust: trusted,   api_key_env: ANTHROPIC_API_KEY }  # api.anthropic.com',
    '  gpt:    { provider: openai,        id: gpt-4o,          trust: untrusted, api_key_env: OPENAI_API_KEY }      # api.openai.com',
    '  # local: { provider: ollama, id: gemma3:27b, trust: local }   # only if localhost egress is allowed',
    'roles:',
    '  advisor: [claude, gpt]        # request-shaped advisors (no tools, no keychain)',
    'policy:',
    '  default_sensitive: false',
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

// Classify a model's readiness WITHOUT sending its credential. Status is one of:
// ok | not-authed | egress-blocked | dns-fail | not-on-path | unknown. HTTP reachability is checked
// with an UNauthenticated request (any HTTP response = egress works); auth is checked by LOCAL
// PRESENCE only (env set, or credential file exists) — never by sending the key.
async function defaultProbe(model) {
  if (model.provider === 'ollama') {
    const base = (model.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    return ollamaStatus(base, model.id);
  }
  if (model.provider === 'openai' || model.provider === 'openai-compatible') {
    return httpAuthedStatus(model, model.baseUrl || 'https://api.openai.com', model.apiKeyEnv || 'OPENAI_API_KEY', '/v1/models');
  }
  if (model.provider === 'anthropic-api') {
    return httpAuthedStatus(model, model.baseUrl || 'https://api.anthropic.com', model.apiKeyEnv || 'ANTHROPIC_API_KEY', '/v1/models');
  }
  if (model.provider === 'anthropic-cli') return cliStatus('claude', model, model.tokenEnv || 'CLAUDE_CODE_OAUTH_TOKEN');
  if (model.provider === 'codex-cli') return cliStatus('codex', model, null);
  return { status: 'unknown', detail: 'unknown provider' };
}

// Ollama is the one provider that will TELL us whether the model is actually available, so ask.
// Reporting "ok" purely because the host answered is a false green: `init` scaffolds a model id, the
// user runs `doctor`, sees all-clear, and only then discovers at consult time that the tag was never
// pulled. `/api/tags` returns the installed list in the same request that proves reachability, so
// checking it costs nothing.
//
// Cloud tags (`model:cloud`) are served by Ollama's hosted side and do NOT appear in the local tag
// list — absence there is not evidence of absence, so those are reported reachable-but-unverified
// rather than missing.
async function ollamaStatus(base, id) {
  let data;
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { status: 'ok', detail: `host reachable (HTTP ${res.status} from /api/tags — model not verified)` };
    data = await res.json();
  } catch (e) {
    const msg = String(e?.message || e);
    if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|dns/i.test(msg)) return { status: 'dns-fail', detail: 'DNS lookup failed' };
    return { status: 'egress-blocked', detail: 'unreachable (timeout/refused — is `ollama serve` running?)' };
  }

  if (/:cloud$/.test(id)) return { status: 'ok', detail: 'host reachable; cloud tag (availability not verifiable locally)' };

  const tags = Array.isArray(data?.models) ? data.models.map((m) => m?.name).filter(Boolean) : [];
  if (!tags.length) return { status: 'ok', detail: 'host reachable (no tag list returned — model not verified)' };
  // Ollama reports bare names as `name:latest`; accept either spelling.
  const wanted = id.includes(':') ? id : `${id}:latest`;
  if (tags.includes(id) || tags.includes(wanted)) return { status: 'ok', detail: 'host reachable, model pulled' };
  return { status: 'model-missing', detail: `not pulled — run \`ollama pull ${id}\`` };
}

// Reachability without credentials. Any HTTP response (even 401) means egress works.
async function httpReachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return { reachable: true };
  } catch (e) {
    const msg = String(e?.message || e);
    if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|dns/i.test(msg)) return { reachable: false, status: 'dns-fail', detail: 'DNS lookup failed' };
    // timeout / connection refused / network unreachable — the classic sandbox-egress-off signature
    return { reachable: false, status: 'egress-blocked', detail: 'unreachable (timeout/refused — egress off?)' };
  }
}

function credentialPresent(model, envName) {
  if (envName && process.env[envName]) return true;
  if (model.apiKeyFile || model.tokenFile) {
    const f = model.apiKeyFile || model.tokenFile;
    const abs = path.isAbsolute(f) ? f : path.resolve(model.configDir || process.cwd(), f);
    try { return fs.statSync(abs).isFile(); } catch { return false; }
  }
  return false;
}

async function httpAuthedStatus(model, base, envName, reachPath) {
  const reach = await httpReachable(base.replace(/\/$/, '') + reachPath);
  if (!reach.reachable) return { status: reach.status, detail: reach.detail };
  if (!credentialPresent(model, envName)) return { status: 'not-authed', detail: `${envName} not set and no api_key_file` };
  return { status: 'ok', detail: 'reachable, credential present (not sent)' };
}

// CLI adapters: on PATH? credential locally present? We cannot verify auth without running it, so a
// binary on PATH is reported 'ok' (auth may come from the tool's own login/keychain).
function cliStatus(cmd, model, tokenEnv) {
  if (!onPath(cmd)) return { status: 'not-on-path', detail: `${cmd} not on PATH` };
  const cred = tokenEnv && (process.env[tokenEnv] || credentialPresent(model, tokenEnv));
  return { status: 'ok', detail: cred ? 'on PATH, token present' : "on PATH (auth via the tool's own login if no token_file)" };
}

function xdgConfigHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function onPath(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      try {
        if (fs.statSync(path.join(d, cmd + ext)).isFile()) return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}

function defaultDetect() {
  return {
    claude: onPath('claude'),
    codex: onPath('codex'),
    ollama: onPath('ollama'),
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

// 0600: the state file records which consults a task has already spent. It lives in a shared temp
// directory, so a world-readable/writable file lets any local user read a task's history or reset
// (or exhaust) its consult budget — and that budget is a COST control.
function writeState(p, state) {
  try {
    fs.writeFileSync(p, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* best-effort — a missing state file just resets the counter */
  }
}

export { USAGE };
