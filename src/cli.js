// CLI logic, factored out of bin/consultum.js so it is unit-testable with injected config/deps/streams.
// Commands: consult | init | doctor | config. The question and context arrive via STDIN, never
// argv (argv leaks to `ps`). Exit codes are the machine-readable failure semantics from errors.js.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { consult } from './consult.js';
import { loadConfig, discoverConfigPath, resolveAdvisorChain, resolveCurator, TRUST_VALUES } from './config.js';
import { ConsultumError, KIND, EXIT } from './errors.js';
import { defaultRuntime } from './run.js';

const USAGE = `consultum — an advisory channel for delegated AI workers

Usage:
  consultum consult [--sensitive] [--panel] [--curate|--no-curate] [--json]
                    [--task-id ID] [--source-path PATH] [--config PATH]
                    (reads the question + context from STDIN — see below)

  consultum init [--interactive] [--print] [--force] [--sandbox] [--config PATH]
  consultum doctor [--config PATH]
  consultum config [--config PATH]

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

// Which flags each command actually implements. An unknown flag must NEVER be silently ignored:
// `--sensitve` (a typo for --sensitive) previously parsed as a positional and the consult proceeded
// as NON-sensitive to an untrusted third-party advisor. That is a fail-open in the one control whose
// entire purpose is failing closed, so an unrecognized flag is a hard usage error.
// `--json` is listed only for `consult` — it is the only command with a JSON success contract.
// `config` always emits JSON, and `doctor` is human-readable; accepting --json there would imply a
// machine-readable success shape that does not exist.
const COMMAND_FLAGS = {
  consult: ['--sensitive', '--panel', '--curate', '--no-curate', '--json', '--task-id', '--source-path', '--config'],
  init: ['--interactive', '-i', '--print', '--force', '--sandbox', '--config'],
  doctor: ['--config'],
  config: ['--config'],
};
// Terminal flags: valid with any command (or none), and they never consult, so they never spend.
const GLOBAL_FLAGS = ['--help', '-h', '--version', '-v'];
// Flags that consume the following token as their value.
const VALUE_FLAGS = new Set(['--task-id', '--source-path', '--config']);

export function parseArgs(argv) {
  const rest = [...argv];
  // The command is the first token that is not a flag (so `consultum --help` has no command).
  const command = rest.length && !rest[0].startsWith('-') ? rest.shift() : undefined;
  // `seen` records every flag LITERAL encountered (recognized or not) so checkArgs can reject a flag
  // that is real but not valid for THIS command (e.g. --panel on doctor) — those set a `flags.*`
  // field and would otherwise never appear in `unknown`. `unknown`/`missingValue` are collected
  // rather than thrown so the caller can still honour --json when reporting the failure.
  const flags = { _: [], seen: [], unknown: [], missingValue: [] };
  const VALUE_DEST = { '--task-id': 'taskId', '--source-path': 'sourcePath', '--config': 'config' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) flags.seen.push(a);
    if (VALUE_FLAGS.has(a)) {
      const v = rest[i + 1];
      // A value flag must not swallow the next flag: `--config --json` means a forgotten path, not a
      // config file literally named "--json". Do NOT consume the token in that case — otherwise a
      // trailing --json would be lost and the resulting error printed as prose instead of JSON.
      if (v === undefined || v.startsWith('-')) flags.missingValue.push(a);
      else {
        flags[VALUE_DEST[a]] = v;
        i++;
      }
      continue;
    }
    if (a === '--sensitive') flags.sensitive = true;
    else if (a === '--curate') flags.curate = true;
    else if (a === '--no-curate') flags.curate = false;
    else if (a === '--panel') flags.panel = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--print') flags.print = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--sandbox') flags.sandbox = true;
    else if (a === '--interactive' || a === '-i') flags.interactive = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--version' || a === '-v') flags.version = true;
    else if (a.startsWith('-')) flags.unknown.push(a);
    else flags._.push(a);
  }
  return { command, flags };
}

// Reject anything the command does not implement. Returns a ConsultumError (USAGE, exit 10) or null;
// it does not throw, so the caller decides how to render it (--json vs human).
export function checkArgs(command, flags) {
  const usage = (msg) => new ConsultumError(KIND.USAGE, msg);
  if (flags.missingValue?.length) {
    return usage(`${flags.missingValue[0]} requires a value`);
  }
  const known = COMMAND_FLAGS[command];
  if (!known) return null; // unknown command — bin/ reports that separately, with the usage text
  const allowed = new Set([...known, ...GLOBAL_FLAGS]);
  // Check EVERY flag literal seen, not just the unrecognized ones: a real flag used on the wrong
  // command (e.g. --panel on doctor) sets a flags.* field and never reaches `unknown`, but is still
  // invalid here. `seen` captures both cases; fall back to `unknown` for older callers.
  const bad = (flags.seen ?? flags.unknown ?? []).find((f) => !allowed.has(f));
  if (bad) {
    const verb = (flags.unknown ?? []).includes(bad) ? 'unknown flag' : 'flag not valid here';
    return usage(`${verb} '${bad}' for 'consultum ${command}' (accepts: ${known.join(', ')})`);
  }
  // A stray positional usually means the question was passed as an argument. It is never read —
  // the question arrives on STDIN, because argv is visible to other users via `ps`.
  if (flags._?.length) {
    const hint =
      command === 'consult'
        ? " — the question is read from STDIN, not argv (argv is visible in `ps`); pipe it in instead"
        : '';
    return usage(`unexpected argument '${flags._[0]}' for 'consultum ${command}'${hint}`);
  }
  return null;
}

// The only keys the JSON stdin protocol defines. An unknown key is rejected rather than dropped:
// a caller sending {"sensitve": true} (or {"sensitive": true}, which is not the way to escalate —
// use --sensitive) would otherwise get a NON-sensitive consult to an untrusted advisor and no
// warning. Same fail-open class as an unknown CLI flag.
const STDIN_JSON_KEYS = ['question', 'context', 'sourcePath'];

export function parseStdin(raw) {
  const text = (raw ?? '').trim();
  if (!text) return { question: '', context: '', sourcePath: null };
  if (text.startsWith('{')) {
    // Leading '{' means the caller INTENDED JSON. Falling back to line-based parsing here would
    // silently turn a truncated packet into a plain-text question and bill a real provider call for
    // it, so a parse failure is a usage error — raised before any money is spent.
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new ConsultumError(
        KIND.USAGE,
        `stdin looks like JSON (starts with '{') but is not valid JSON: ${e.message}. ` +
          `Send {"question": "...", "context": "..."} or plain text (first line = question).`,
      );
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new ConsultumError(KIND.USAGE, 'stdin JSON must be an object, e.g. {"question": "...", "context": "..."}');
    }
    const unknown = Object.keys(obj).find((k) => !STDIN_JSON_KEYS.includes(k));
    if (unknown) {
      const hint = /^sensit/i.test(unknown) ? ' — sensitivity is set with the --sensitive flag, not on stdin' : '';
      throw new ConsultumError(
        KIND.USAGE,
        `stdin JSON has unknown key '${unknown}' (accepts: ${STDIN_JSON_KEYS.join(', ')})${hint}`,
      );
    }
    // sourcePath drives per-path sensitivity, so it must be a real string — String({}) would become
    // "[object Object]" and silently match nothing, quietly defeating a sensitive_paths rule.
    if (obj.sourcePath !== undefined && obj.sourcePath !== null && typeof obj.sourcePath !== 'string') {
      throw new ConsultumError(KIND.USAGE, 'stdin JSON "sourcePath" must be a string');
    }
    return {
      question: String(obj.question ?? '').trim(),
      context: String(obj.context ?? '').trim(),
      sourcePath: obj.sourcePath ? String(obj.sourcePath) : null,
    };
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
    '=== consultum recommendation ===',
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
        lines.push('(i) No reconciler configured — the views above are NOT assessed for agreement.', '    consultum will not guess whether they agree; read them and decide.', '');
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
  let parsed;
  try {
    parsed = parseStdin(stdin);
  } catch (e) {
    // A malformed packet is rejected here, BEFORE any provider is contacted or billed.
    return emitError(e, flags, err);
  }
  const { question, context, sourcePath: stdinSourcePath } = parsed;
  // --source-path (host-supplied) wins; a JSON stdin sourcePath is a fallback. Either way sensitivity
  // is escalate-only, so a caller-provided path can only ADD sensitivity, never relax it.
  const sourcePath = flags.sourcePath ?? stdinSourcePath ?? null;
  if (!question) {
    err(`consultum consult: no question on stdin.\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  let cfg = config;
  try {
    cfg = cfg ?? loadConfig({ configPath: flags.config });
  } catch (e) {
    return emitError(e, flags, err);
  }

  // State for library-mode consult limits, only if --task-id is passed. The read → budget-check →
  // consult → record → write sequence runs under an exclusive lock so concurrent processes sharing a
  // --task-id cannot both slip past the cap (see acquireStateLock). readState fails closed on a
  // corrupt/unreadable file, so this can throw before consulting — which is correct: we will not spend
  // against an unknown budget.
  let state = null;
  let statePath = null;
  let releaseLock = null;
  if (flags.taskId) {
    // os.tmpdir() honors TMPDIR/TEMP/TMP per platform; the old `TMPDIR || '/tmp'` wrote to a
    // literal `\tmp` on Windows, where TMPDIR is not set.
    statePath = path.join(os.tmpdir(), `consultum-state-${sanitize(flags.taskId)}.json`);
    try {
      releaseLock = await acquireStateLock(statePath);
      state = readState(statePath);
    } catch (e) {
      if (releaseLock) releaseLock();
      return emitError(e, flags, err);
    }
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
    // consult() mutated `state` (recorded this consult) on success; persist it inside the lock.
    if (state && statePath) writeState(statePath, state);
    if (flags.json) out(JSON.stringify(rec, null, 2));
    else out(formatHuman(rec));
    return rec.lowConfidence ? EXIT.LOW_CONFIDENCE : EXIT.OK;
  } catch (e) {
    return emitError(e, flags, err);
  } finally {
    if (releaseLock) releaseLock();
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
  out(`consultum doctor — config: ${cfg.path ?? '(injected)'}`);
  out('');
  out('models:');
  const statusByName = {};
  let sawEgressBlock = false;
  let sawMissingModel = false;
  let sawOkUnverified = false;
  for (const [name, m] of Object.entries(cfg.models)) {
    const s = await probe(m);
    statusByName[name] = s;
    if (s.status === 'egress-blocked') sawEgressBlock = true;
    if (s.status === 'model-missing') sawMissingModel = true;
    if (s.status === 'ok-unverified') sawOkUnverified = true;
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
  if (sawOkUnverified) {
    out('');
    out('  (!) ok-unverified: reachable and usable, but the model id itself was not validated — a wrong');
    out('      or retired id will fail at consult time, not here. Verify the id against the provider.');
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
  // 'ok-unverified' counts as usable — the host/binary is reachable, only the exact model id is
  // unverified, which is a real-but-different risk (see the footnote above), not an unusable setup.
  const usable = normalChain.some((m) => isUsable(statusByName[m.name]?.status));
  if (!usable) {
    out('');
    out('  (!) no usable advisor in the normal chain — fix auth/egress above before consulting.');
    return EXIT.PROVIDER_ERROR;
  }
  return EXIT.OK;
}

// The interactive wizard writes the SAME YAML schema `init` already produces — it just fills the
// values in instead of leaving a template to hand-edit. Deliberately a terminal flow, not a local
// web UI: consultum's primary caller is an automated worker running headless, in a sandbox, over SSH or
// in CI, where a browser wizard is unreachable — and standing up an HTTP listener that renders API
// keys would add a real attack surface (DNS rebinding / CSRF against localhost) to a tool whose
// whole job is handling secrets carefully. See docs/architecture.md.
export async function runInitInteractive({ flags, out, err, detect = defaultDetect, ask, cwd = process.cwd(), writeFile = fs.writeFileSync, exists = fs.existsSync, mkdir = fs.mkdirSync }) {
  const detected = await detect({ sandbox: Boolean(flags.sandbox) });
  out('consultum init — interactive. Enter to accept the [default]; Ctrl-C to abort.');
  const detectedProviderKeys = ['claude', 'codex', 'ollama'];
  out(`detected on PATH: ${detectedProviderKeys.filter((k) => detected[k]).join(', ') || 'none'}`);
  out('');

  const models = [];
  const advisor = [];

  const addModel = async (key, label, provider, defaultId, trust, hint) => {
    const yes = await ask(`Configure ${label}? [Y/n] `);
    if (/^n/i.test(yes.trim())) return;
    // defaultId may be null (e.g. Codex, whose id is account-specific and not safe to guess) — then
    // the id is required and a blank answer skips the model rather than writing an empty (invalid) id.
    const idPrompt = defaultId ? `  model id for ${label} [${defaultId}]: ` : `  model id for ${label} (required, blank to skip): `;
    const id = (await ask(idPrompt)).trim() || defaultId || '';
    if (!id) {
      err(`  no model id given — skipping ${label}.`);
      return;
    }
    const t = (await ask(`  trust for ${label} — local|trusted|untrusted [${trust}]: `)).trim() || trust;
    if (!TRUST_VALUES.includes(t)) {
      err(`  '${t}' is not a valid trust value; using '${trust}'.`);
    }
    const useTrust = TRUST_VALUES.includes(t) ? t : trust;
    models.push(`  ${key}: { provider: ${provider}, id: ${id}, trust: ${useTrust} }${hint ? `  # ${hint}` : ''}`);
    advisor.push(key);
  };

  if (detected.claude) await addModel('claude', 'Claude Code CLI', 'anthropic-cli', 'claude-opus-4-8', 'trusted', 'uses the CLI login');
  // Codex id is account-tier-specific (`gpt-5-codex`/`gpt-5` are rejected on ChatGPT accounts), so
  // there is no safe literal to default to. Offer the model from ~/.codex/config.toml if we found one;
  // otherwise addModel prompts for a required id (blank skips) rather than writing a broken default.
  if (detected.codex) await addModel('codex', 'Codex CLI', 'codex-cli', detected.codexModel, 'untrusted', 'read-capable agent, NOT no-tools');
  if (detected.ollama) await addModel('local', 'Ollama (local)', 'ollama', detected.ollamaModel || 'llama3.1:8b', 'local', 'localhost, no key');
  if (!models.length) {
    out('Nothing detected — adding an Ollama entry you can edit.');
    models.push(`  local: { provider: ollama, id: ${detected.ollamaModel || 'llama3.1:8b'}, trust: local }`);
    advisor.push('local');
  }

  const curator = (await ask(`Curator model (compresses context before the advisor) — a model key, or blank for none [none]: `)).trim();
  const sens = await ask('Treat every request as sensitive by default (third-party advisors refused)? [y/N] ');

  const content = [
    '# consultum config. Secrets are NEVER stored here — models reference env vars only.',
    '# `consultum doctor` checks reachability + local auth; it confirms the exact model id only for',
    '# locally-pulled Ollama tags — anything else reports ok-unverified (usable, id not confirmed).',
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

  const target = flags.config ?? path.join(cwd, 'consultum.yaml');
  if (exists(target) && !flags.force) {
    err(`consultum init: ${target} already exists. Use --force to overwrite.`);
    return EXIT.USAGE;
  }
  mkdir(path.dirname(target), { recursive: true });
  writeFile(target, content, 'utf8');
  out('');
  out(`wrote ${target}`);
  out('next: `consultum doctor` to verify, then pipe a question into `consultum consult`.');
  return EXIT.OK;
}

export async function runInit({ flags, out, err, detect = defaultDetect, cwd = process.cwd(), writeFile = fs.writeFileSync, exists = fs.existsSync, mkdir = fs.mkdirSync }) {
  const detected = await detect({ sandbox: Boolean(flags.sandbox) });
  const content = generateStarterConfig(detected, { sandbox: Boolean(flags.sandbox) });
  if (flags.print) {
    out(content);
    return EXIT.OK;
  }
  // The sandbox preset must NOT default into the worker-writable cwd (threat-model A7). Default it to
  // the user config dir instead; a non-sandbox init still uses ./consultum.yaml.
  const defaultTarget = flags.sandbox
    ? path.join(xdgConfigHome(), 'consultum', 'config.yaml')
    : path.join(cwd, 'consultum.yaml');
  const target = flags.config ?? defaultTarget;
  if (exists(target) && !flags.force) {
    err(`consultum init: ${target} already exists. Use --force to overwrite, or --print to preview.`);
    return EXIT.USAGE;
  }
  mkdir(path.dirname(target), { recursive: true }); // create ~/.config/consultum etc. so the write succeeds
  writeFile(target, content, 'utf8');
  out(`wrote ${target}`);
  if (flags.sandbox) {
    out('sandbox preset: HTTP adapters only (no keychain, no bundled CLI). Set OPENAI_API_KEY /');
    out('ANTHROPIC_API_KEY (or api_key_file), and allowlist egress to api.openai.com / api.anthropic.com.');
    out('IMPORTANT: keep this config OUTSIDE any worker-writable dir — set CONSULTUM_CONFIG to a path a');
    out('worker cannot write (threat-model A7). See docs/sandboxed-callers.md.');
  } else {
    const providerKeys = ['claude', 'codex', 'ollama'];
    out(`detected providers: ${providerKeys.filter((k) => detected[k]).join(', ') || 'none'}`);
  }
  out('next: `consultum doctor` to verify, then pipe a question into `consultum consult`.');
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
    if (detected.codexModel) {
      // Scaffold the model the user's codex is actually configured with (the one `codex exec` uses).
      models.push(`  codex:  { provider: codex-cli,     id: ${detected.codexModel}, trust: untrusted } # from ~/.codex/config.toml; read-capable agent, NOT a no-tools advisor (docs/threat-model.md)`);
      advisor.push('codex');
    } else {
      // No model id in ~/.codex/config.toml and none is safe to hardcode (account-tier-specific).
      // Leave it commented so init never scaffolds a known-broken advisor into the chain.
      models.push('  # codex: { provider: codex-cli, id: <your-codex-model>, trust: untrusted } # set to a model your codex account supports (see `codex exec`); read-capable, NOT no-tools');
    }
  }
  if (detected.ollama) {
    const id = detected.ollamaModel || 'llama3.1:8b';
    const hint = detected.ollamaModel ? '# localhost, no key — largest local tag found by `init`' : '# localhost, no key';
    models.push(`  local:  { provider: ollama,        id: ${id},      trust: local }     ${hint}`);
    if (advisor.length === 0) advisor.push('local');
  }
  if (models.length === 0) {
    // Nothing detected — emit a commented template the user can fill in.
    models.push('  local:  { provider: ollama,        id: llama3.1:8b,      trust: local }     # start Ollama, or edit this');
    advisor.push('local');
  }
  return [
    '# consultum config. Secrets are NEVER stored here — models reference env vars only.',
    '# Model ids below are EXAMPLES — change them to models you actually have.',
    '# `consultum doctor` tells you which are reachable; it confirms the exact model id only for',
    '# locally-pulled Ollama tags — anything else reports ok-unverified (usable, id not confirmed).',
    '# Reference: https://github.com/Pher217/consultum#docs',
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
    '# consultum — sandbox preset. HTTP adapters only (keychain-free, one host each).',
    '# Keys come from env vars (or api_key_file). Keep THIS FILE outside any worker-writable dir',
    '# and point CONSULTUM_CONFIG at it (threat-model A7). trust: local | trusted | untrusted.',
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

export function emitError(e, flags, err) {
  if (e instanceof ConsultumError) {
    if (flags.json) err(JSON.stringify(e.toJSON()));
    else err(`consultum: ${e.kind}: ${e.message}`);
    return e.exitCode;
  }
  if (flags.json) err(JSON.stringify({ error: { kind: 'error', message: e.message } }));
  else err(`consultum: error: ${e.message}`);
  return 1;
}

// Classify a model's readiness WITHOUT sending its credential. Status is one of:
// ok | ok-unverified | not-authed | egress-blocked | dns-fail | not-on-path | unknown. HTTP
// reachability is checked with an UNauthenticated request (any HTTP response = egress works); auth is
// checked by LOCAL PRESENCE only (env set, or credential file exists) — never by sending the key.
// 'ok-unverified' means reachable/usable but the exact model id was NOT confirmed against the
// provider (CLI adapters, cloud Ollama tags, or an Ollama host that didn't return a tag list) — see
// isUsable() and the runDoctor footnote below.
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
    if (!res.ok) return { status: 'ok-unverified', detail: `host reachable (HTTP ${res.status} from /api/tags — model not verified)` };
    data = await res.json();
  } catch (e) {
    const msg = String(e?.message || e);
    if (/getaddrinfo|ENOTFOUND|EAI_AGAIN|dns/i.test(msg)) return { status: 'dns-fail', detail: 'DNS lookup failed' };
    return { status: 'egress-blocked', detail: 'unreachable (timeout/refused — is `ollama serve` running?)' };
  }

  if (/:cloud$/.test(id)) return { status: 'ok-unverified', detail: 'host reachable; cloud tag (availability not verifiable locally)' };

  const tags = Array.isArray(data?.models) ? data.models.map((m) => m?.name).filter(Boolean) : [];
  if (!tags.length) return { status: 'ok-unverified', detail: 'host reachable (no tag list returned — model not verified)' };
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
  // Reachability + local credential PRESENCE is all we checked — the exact model id was never sent to
  // the provider (doing so would require an authenticated call, which doctor deliberately avoids). So
  // this is 'ok-unverified', not 'ok': a wrong or retired id (e.g. a typo'd `gpt-4o`) will fail at
  // consult time, not here. PR #10 made this honesty fix for the CLI and Ollama adapters but missed
  // the HTTP path (openai / anthropic-api / openai-compatible); this closes that gap.
  return { status: 'ok-unverified', detail: 'reachable, credential present (not sent); model id not verified' };
}

// CLI adapters: on PATH? credential locally present? We cannot verify auth without running it, and we
// never invoke the CLI just to check the model id, so a binary on PATH is reported 'ok-unverified' —
// reachable and usable, but the configured model id itself was never validated against the provider.
function cliStatus(cmd, model, tokenEnv) {
  if (!onPath(cmd)) return { status: 'not-on-path', detail: `${cmd} not on PATH` };
  const cred = tokenEnv && (process.env[tokenEnv] || credentialPresent(model, tokenEnv));
  return {
    status: 'ok-unverified',
    detail: cred ? 'on PATH, token present (model id not verified)' : "on PATH (auth via the tool's own login if no token_file; model id not verified)",
  };
}

// 'ok' and 'ok-unverified' are both usable — the difference is whether the exact model id was
// confirmed against the provider (ok) or only the host/binary was found reachable (ok-unverified).
function isUsable(status) {
  return status === 'ok' || status === 'ok-unverified';
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

// Detection is used by both `init` and `init --interactive` to scaffold a config the user doesn't
// have to hand-edit before `doctor` goes green. For Ollama specifically, a PATH check alone isn't
// enough — the starter config also needs a model id the user actually has pulled, or `doctor` reports
// model-missing on the very first run. `--sandbox` must never make this network call (no egress there).
async function defaultDetect({ sandbox = false } = {}) {
  const ollama = onPath('ollama');
  const codex = onPath('codex');
  return {
    claude: onPath('claude'),
    codex,
    ollama,
    ollamaModel: ollama && !sandbox ? await pickOllamaTag() : null,
    // Codex model ids are account-tier-specific — `gpt-5-codex` / `gpt-5` are rejected on a ChatGPT
    // account ("not supported when using Codex with a ChatGPT account"), so there is NO id that is
    // valid to hardcode. Read the model the user has already configured and that `codex exec` uses.
    codexModel: codex ? pickCodexModel() : null,
  };
}

// The model id from the user's codex config (`$CODEX_HOME/config.toml`, default `~/.codex/config.toml`),
// i.e. the one `codex exec` runs with no `-m`. Returns null if unreadable or unset — the caller then
// scaffolds codex commented-out rather than guessing a literal that may be invalid for the account.
function pickCodexModel() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    // Top-level `model = "..."`, not a `[section]` key. Match a bare (non-indented) assignment before
    // the first table header so a `[profiles.x] model = ...` deeper in the file can't be misread.
    for (const line of toml.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break; // reached the first [table] — stop scanning top-level keys
      const m = line.match(/^\s*model\s*=\s*["']([^"']+)["']\s*(#.*)?$/);
      if (m) return m[1];
    }
  } catch {
    /* no config / unreadable — fall through to null */
  }
  return null;
}

// Domain-specialised model families that are poor general-purpose advisors even though they report a
// plain `completion` capability (so the capability array alone can't reject them). Demoted, not
// dropped — a domain model is still better than a placeholder the user definitely doesn't have.
const DOMAIN_MODEL_RE = /^(medgemma|meditron|biomistral|codegemma|starcoder|sqlcoder|deepseek-coder|codellama)/i;

// Score a candidate for general-advisor suitability. `tools` (instruction-tuned function-calling) is a
// strong proxy for "general assistant"; vision-primary and domain models are ranked down but not
// excluded, because modern flagship general models are increasingly multimodal (excluding vision would
// reject genuinely good advisors). Size is the final tie-break, preserving the old "largest wins"
// heuristic among otherwise-equal candidates. Ollama < 0.4-ish omits `capabilities`, so a missing
// array scores 0 and the pick degrades gracefully to size order.
function scoreOllamaTag(m) {
  const name = String(m?.name || '');
  const caps = Array.isArray(m?.capabilities) ? m.capabilities : [];
  let score = 0;
  if (caps.includes('tools')) score += 4;
  if (caps.includes('thinking')) score += 2;
  if (DOMAIN_MODEL_RE.test(name)) score -= 3;
  // vision-capable but NOT a general text model (no tools) — likely a vision-primary model as advisor.
  if (caps.includes('vision') && !caps.includes('tools')) score -= 1;
  return score;
}

// Picks the tag most likely to be a capable general-purpose local model. `/api/tags` returns a
// per-model `capabilities` array in the same request that proves reachability, so we filter on it for
// free (no `/api/show` probe needed): drop `:cloud` tags (not "local" in the sense init cares about)
// and embedding models (useless as an advisor), then rank the rest by general-advisor suitability,
// size as the tie-break. INVARIANT: capability filtering only changes WHICH tag is picked — it must
// never turn a non-empty tag list into a null (that would reintroduce the first-run `model-missing`
// friction this detection exists to remove). Never throws — a failed/timed-out probe returns null and
// the caller falls back to the placeholder id.
async function pickOllamaTag(fetchImpl = fetch) {
  try {
    // Honour OLLAMA_HOST — a user who moved the daemon off the default port would otherwise get the
    // placeholder id back and hit `model-missing` on their first `doctor`.
    const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '');
    const base = /^https?:\/\//.test(host) ? host : `http://${host}`;
    const res = await fetchImpl(`${base}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models : [];

    // Hard rejects: never usable as a text advisor. Applied first; the fallback below degrades ONLY
    // these, never the soft scoring, so a capable-but-unscored tag is always preferred over nothing.
    const notLocalOrEmbedding = (m) => {
      const name = String(m?.name || '');
      if (!name) return false;
      if (/:cloud$/.test(name)) return false;
      const caps = Array.isArray(m?.capabilities) ? m.capabilities : [];
      if (caps.includes('embedding')) return false; // authoritative when present
      if (caps.length && !caps.includes('completion')) return false; // present but can't do text
      if (/^bge/i.test(name) || /embed/i.test(name)) return false; // name fallback for daemons w/o caps
      return true;
    };

    const candidates = models.filter(notLocalOrEmbedding);
    if (!candidates.length) return null;
    // Best general-advisor score wins; size breaks ties (stable-ish, deterministic).
    candidates.sort((a, b) => scoreOllamaTag(b) - scoreOllamaTag(a) || (Number(b?.size) || 0) - (Number(a?.size) || 0));
    return candidates[0].name;
  } catch {
    return null;
  }
}

function sanitize(s) {
  return String(s).replace(/[^A-Za-z0-9_.\-]/g, '_');
}

// The --task-id state file holds a COST control (how many consults a task has spent). A silent reset
// of that budget is a real failure, so reads FAIL CLOSED: a missing file is a legitimate first
// consult ({}), but a file that exists and is corrupt, non-object, or unreadable throws rather than
// pretending the budget is fresh — which would let a garbled or tampered file grant unlimited paid
// consults.
function readState(p) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return {}; // no prior consults for this task — the normal first run
    throw new ConsultumError(
      KIND.USAGE,
      `could not read consult-budget state ${p}: ${e.message}. Refusing to consult with an unknown budget; remove the file to reset, or fix its permissions.`,
    );
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new ConsultumError(
      KIND.USAGE,
      `consult-budget state ${p} is corrupt (${e.message}). Refusing to consult with an unknown budget; delete the file to reset it.`,
    );
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ConsultumError(KIND.USAGE, `consult-budget state ${p} is not a JSON object. Delete the file to reset it.`);
  }
  return obj;
}

// Atomic write: a concurrent reader must never see a half-written file (which readState would now
// reject as corrupt). Write a temp file in the same dir, then rename (atomic on POSIX and Windows).
// 0600 because the file lives in a shared temp dir — a world-readable/writable budget file lets any
// local user read a task's history or reset/exhaust its (cost-controlling) budget. THROWS on failure:
// a swallowed write means the spend is never recorded and the next run gets a free slot — a silent
// leak of the exact control this file exists to enforce.
function writeState(p, state) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
}

// A stale lock is broken after this long — a process that crashed mid-consult must not wedge a
// task-id forever. Sized above the longest realistic consult (curator 90s + a slow advisor).
const STATE_LOCK_STALE_MS = 5 * 60_000;
const STATE_LOCK_RETRY_MS = 100;
const STATE_LOCK_WAIT_MS = 6 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Acquire an exclusive lock for a task-id's state file so the read → check-budget → reserve → write
// sequence is atomic across concurrently-running consultum processes that share a --task-id. Without
// it, two workers both read "2 of 3 spent", both proceed, and the cap is silently exceeded (and the
// last writer clobbers the other's record). Held across the consult so the budget check and the spend
// are one critical section; this serializes same-task-id consults, which is the correct behaviour for
// a SHARED budget (workers wanting parallelism use distinct task-ids). Returns a release fn.
async function acquireStateLock(statePath) {
  const lockPath = `${statePath}.lock`;
  const deadline = nowMs() + STATE_LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx'); // O_CREAT|O_EXCL — fails if the lock already exists
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(lockPath); } catch { /* already gone */ } };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      // Break a stale lock left by a crashed process.
      try {
        const age = nowMs() - fs.statSync(lockPath).mtimeMs;
        if (age > STATE_LOCK_STALE_MS) { fs.unlinkSync(lockPath); continue; }
      } catch { /* lock vanished between open and stat — just retry */ }
      if (nowMs() >= deadline) {
        throw new ConsultumError(KIND.USAGE, `timed out waiting for the consult-budget lock ${lockPath}. Another consult with the same --task-id may be running; retry, or remove a stale lock.`);
      }
      await sleep(STATE_LOCK_RETRY_MS);
    }
  }
}

// Wall-clock helper. Date.now is avoided elsewhere in this codebase's workflow tooling, but here we
// genuinely need real time for lock-staleness and a wait deadline; nothing depends on it being
// deterministic.
function nowMs() {
  return Date.now();
}

export { USAGE, cliStatus, ollamaStatus, httpAuthedStatus, isUsable, defaultDetect, pickOllamaTag, pickCodexModel, readState, writeState, acquireStateLock };
