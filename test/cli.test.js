import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  parseStdin,
  runConsult,
  runConfig,
  runDoctor,
  runInit,
  generateStarterConfig,
} from '../src/cli.js';
import { parseConfig } from '../src/config.js';

const REC = '## Recommended Approach\nDo the safe thing.\n## Confidence\n88';
const LOWREC = '## Recommended Approach\nMaybe.\n## Confidence\n40';

const CFG = parseConfig(`
models:
  adv: { provider: ollama,    id: adv-model, trust: trusted }
  sol: { provider: codex-cli, id: sol-model, trust: untrusted }
roles:
  advisor: [adv, sol]
policy:
  default_sensitive: false
`);

function okDeps(recText = REC) {
  return {
    httpPostJson: async () => ({ message: { content: recText } }),
    runNoStdin: async () => ({ code: 0, stdout: recText, stderr: '', timedOut: false }),
    runWithStdin: async () => ({ code: 0, stdout: recText, stderr: '', timedOut: false }),
  };
}
function sink() {
  const lines = [];
  return { fn: (s) => lines.push(s), lines, text: () => lines.join('\n') };
}

// ---- parsing ---------------------------------------------------------------

test('parseArgs collects flags and command', () => {
  const { command, flags } = parseArgs(['consult', '--sensitive', '--json', '--task-id', 'T1', '--config', 'c.yaml']);
  assert.equal(command, 'consult');
  assert.equal(flags.sensitive, true);
  assert.equal(flags.json, true);
  assert.equal(flags.taskId, 'T1');
  assert.equal(flags.config, 'c.yaml');
});

test('parseArgs recognizes --version / -v', () => {
  assert.equal(parseArgs(['--version']).flags.version, true);
  assert.equal(parseArgs(['-v']).flags.version, true);
});

test('parseArgs --no-curate sets curate false, --curate sets true', () => {
  assert.equal(parseArgs(['consult', '--no-curate']).flags.curate, false);
  assert.equal(parseArgs(['consult', '--curate']).flags.curate, true);
});

test('parseStdin: JSON form (with optional sourcePath)', () => {
  assert.deepEqual(parseStdin('{"question":"q","context":"c"}'), { question: 'q', context: 'c', sourcePath: null });
  assert.deepEqual(parseStdin('{"question":"q","context":"c","sourcePath":"a/b.pem"}'), { question: 'q', context: 'c', sourcePath: 'a/b.pem' });
});

test('parseStdin: first line is question, rest is context', () => {
  assert.deepEqual(parseStdin('why does it fail?\nline1\nline2'), { question: 'why does it fail?', context: 'line1\nline2', sourcePath: null });
});

test('parseStdin: single line and empty', () => {
  assert.deepEqual(parseStdin('just a question'), { question: 'just a question', context: '', sourcePath: null });
  assert.deepEqual(parseStdin('  '), { question: '', context: '', sourcePath: null });
});

// ---- consult ---------------------------------------------------------------

test('runConsult: success prints recommendation and returns 0', async () => {
  const out = sink();
  const err = sink();
  const code = await runConsult({ stdin: 'why flaky?\ncontext', flags: {}, config: CFG, deps: okDeps(), out: out.fn, err: err.fn });
  assert.equal(code, 0);
  assert.match(out.text(), /Do the safe thing\./);
  assert.match(out.text(), /confidence: 88/);
});

test('runConsult: --json prints structured JSON', async () => {
  const out = sink();
  const code = await runConsult({ stdin: 'q\nctx', flags: { json: true }, config: CFG, deps: okDeps(), out: out.fn, err: sink().fn });
  assert.equal(code, 0);
  const obj = JSON.parse(out.text());
  assert.equal(obj.recommendation, 'Do the safe thing.');
  assert.equal(obj.provenance.advisorModel, 'adv-model');
});

test('runConsult: low confidence returns exit 14 but still prints', async () => {
  const out = sink();
  const code = await runConsult({ stdin: 'q\nctx', flags: {}, config: CFG, deps: okDeps(LOWREC), out: out.fn, err: sink().fn });
  assert.equal(code, 14);
  assert.match(out.text(), /low confidence/);
});

test('runConsult: no question on stdin returns usage exit 10', async () => {
  const err = sink();
  const code = await runConsult({ stdin: '   ', flags: {}, config: CFG, deps: okDeps(), out: sink().fn, err: err.fn });
  assert.equal(code, 10);
  assert.match(err.text(), /no question on stdin/);
});

test('runConsult: --source-path matching sensitive_paths forces refuse (exit 11)', async () => {
  const cfg = parseConfig('models:\n  sol: { provider: codex-cli, id: s, trust: untrusted }\nroles:\n  advisor: [sol]\npolicy:\n  sensitive_paths: ["**/secrets/**"]\n');
  const err = sink();
  const code = await runConsult({ stdin: 'q\nc', flags: { sourcePath: 'app/secrets/x' }, config: cfg, deps: okDeps(), out: sink().fn, err: err.fn });
  assert.equal(code, 11);
  assert.match(err.text(), /refused-by-policy/);
});

test('runConsult: sensitive request with only untrusted advisor is refused (exit 11)', async () => {
  const cfg = parseConfig('models:\n  sol: { provider: codex-cli, id: s, trust: untrusted }\nroles:\n  advisor: [sol]\n');
  const err = sink();
  const code = await runConsult({ stdin: 'q\nc', flags: { sensitive: true }, config: cfg, deps: okDeps(), out: sink().fn, err: err.fn });
  assert.equal(code, 11);
  assert.match(err.text(), /refused-by-policy/);
});

test('runConsult: provider error returns exit 12, --json error shape', async () => {
  const badDeps = { httpPostJson: async () => { throw new Error('down'); }, runNoStdin: async () => ({ code: 1, stdout: '', stderr: 'x', timedOut: false }) };
  const err = sink();
  const code = await runConsult({ stdin: 'q\nc', flags: { json: true }, config: CFG, deps: badDeps, out: sink().fn, err: err.fn });
  assert.equal(code, 12);
  const obj = JSON.parse(err.text());
  assert.equal(obj.error.kind, 'provider-error');
});

// ---- config / doctor / init ------------------------------------------------

test('runConfig prints models, roles, policy', async () => {
  const out = sink();
  const code = await runConfig({ flags: {}, config: CFG, out: out.fn, err: sink().fn });
  assert.equal(code, 0);
  const obj = JSON.parse(out.text());
  assert.deepEqual(obj.roles.advisor, ['adv', 'sol']);
  assert.equal(obj.models.adv.trust, 'trusted');
});

test('runDoctor prints resolved roles and flags a sensitive-refused config', async () => {
  const cfg = parseConfig('models:\n  sol: { provider: codex-cli, id: s, trust: untrusted }\nroles:\n  advisor: [sol]\n');
  const out = sink();
  const probe = async () => ({ status: 'ok', detail: '' });
  const code = await runDoctor({ flags: {}, config: cfg, out: out.fn, err: sink().fn, probe });
  assert.equal(code, 0);
  assert.match(out.text(), /advisor \(sensitive\):.*REFUSED/);
});

test('runDoctor exits non-zero when no advisor is usable, and hints at a blocked sandbox', async () => {
  const cfg = parseConfig('models:\n  a: { provider: anthropic-api, id: x, trust: trusted }\nroles:\n  advisor: [a]\n');
  const out = sink();
  const probe = async () => ({ status: 'egress-blocked', detail: 'unreachable' });
  const code = await runDoctor({ flags: {}, config: cfg, out: out.fn, err: sink().fn, probe });
  assert.equal(code, 12);
  assert.match(out.text(), /egress-blocked/);
  assert.match(out.text(), /sandbox/i);
  assert.match(out.text(), /no usable advisor/);
});

test('generateStarterConfig --sandbox emits HTTP-only adapters and a request-shaped chain', () => {
  const cfg = generateStarterConfig({ claude: true, codex: true, ollama: true }, { sandbox: true });
  assert.match(cfg, /provider: anthropic-api/);
  assert.match(cfg, /provider: openai/);
  assert.doesNotMatch(cfg, /anthropic-cli|codex-cli/);
  assert.match(cfg, /advisor: \[claude, gpt\]/);
  // it must parse and resolve
  const parsed = parseConfig(cfg);
  assert.ok(parsed.roles.advisor.length >= 1);
});

test('runInit --sandbox --print includes the config-outside-workspace guidance path', () => {
  const out = sink();
  const code = runInit({ flags: { sandbox: true, print: true }, out: out.fn, err: sink().fn, detect: () => ({}), writeFile: () => {} });
  assert.equal(code, 0);
  assert.match(out.text(), /anthropic-api/);
});

test('generateStarterConfig builds an ordered advisor chain from detected providers', () => {
  const all = generateStarterConfig({ claude: true, codex: true, ollama: true });
  assert.match(all, /advisor: \[opus, sol\]/);
  assert.match(all, /provider: anthropic-cli/);
  const none = generateStarterConfig({ claude: false, codex: false, ollama: false });
  assert.match(none, /advisor: \[local\]/);
});

test('runInit uses the real provider detector without crashing (regression: probeOnPath rename)', () => {
  const out = sink();
  const code = runInit({ flags: { print: true }, out: out.fn, err: sink().fn }); // no detect injected -> defaultDetect
  assert.equal(code, 0);
  assert.match(out.text(), /models:/);
});

test('runInit --print emits a starter config without writing', () => {
  const out = sink();
  let wrote = false;
  const code = runInit({ flags: { print: true }, out: out.fn, err: sink().fn, detect: () => ({ claude: true, codex: false, ollama: true }), writeFile: () => { wrote = true; } });
  assert.equal(code, 0);
  assert.equal(wrote, false);
  assert.match(out.text(), /models:/);
});

test('runInit --sandbox writes OUTSIDE the workspace (XDG), not ./askup.yaml (Fable finding 1)', () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/tmp/askup-xdgtest';
  try {
    let written = null;
    let mkdirp = null;
    const code = runInit({
      flags: { sandbox: true },
      out: sink().fn,
      err: sink().fn,
      detect: () => ({}),
      exists: () => false,
      writeFile: (p) => { written = p; },
      mkdir: (p) => { mkdirp = p; },
      cwd: '/work',
    });
    assert.equal(code, 0);
    assert.match(written, /\/tmp\/askup-xdgtest\/askup\/config\.yaml$/);
    assert.doesNotMatch(written, /\/work\//);
    assert.match(mkdirp, /\/tmp\/askup-xdgtest\/askup$/);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test('runInit refuses to overwrite an existing config without --force', () => {
  const err = sink();
  const code = runInit({ flags: {}, out: sink().fn, err: err.fn, detect: () => ({ ollama: true }), exists: () => true, writeFile: () => { throw new Error('should not write'); }, cwd: '/tmp' });
  assert.equal(code, 10);
  assert.match(err.text(), /already exists/);
});

test('runInit writes when target does not exist', () => {
  const out = sink();
  let written = null;
  const code = runInit({ flags: {}, out: out.fn, err: sink().fn, detect: () => ({ ollama: true }), exists: () => false, writeFile: (p, c) => { written = { p, c }; }, cwd: '/tmp' });
  assert.equal(code, 0);
  assert.match(written.p, /askup\.yaml$/);
  assert.match(written.c, /models:/);
});
