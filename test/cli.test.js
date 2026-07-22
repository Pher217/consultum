import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs,
  checkArgs,
  runInitInteractive,
  parseStdin,
  runConsult,
  runConfig,
  runDoctor,
  runInit,
  generateStarterConfig,
  cliStatus,
  ollamaStatus,
  httpAuthedStatus,
  isUsable,
  defaultDetect,
  pickOllamaTag,
  readState,
  writeState,
  acquireStateLock,
} from '../src/cli.js';
import { parseConfig } from '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REC = '## Recommended Approach\nDo the safe thing.\n## Confidence\n88';
const LOWREC = '## Recommended Approach\nMaybe.\n## Confidence\n40';

const CFG = parseConfig(`
models:
  adv: { provider: ollama,    id: adv-model, trust: trusted }
  gpt: { provider: codex-cli, id: gpt-model, trust: untrusted }
roles:
  advisor: [adv, gpt]
policy:
  default_sensitive: false
`);

function okDeps(recText = REC) {
  return {
    httpPostJson: async () => ({ message: { content: recText } }),
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
  const cfg = parseConfig('models:\n  gpt: { provider: codex-cli, id: s, trust: untrusted }\nroles:\n  advisor: [gpt]\npolicy:\n  sensitive_paths: ["**/secrets/**"]\n');
  const err = sink();
  const code = await runConsult({ stdin: 'q\nc', flags: { sourcePath: 'app/secrets/x' }, config: cfg, deps: okDeps(), out: sink().fn, err: err.fn });
  assert.equal(code, 11);
  assert.match(err.text(), /refused-by-policy/);
});

test('runConsult: sensitive request with only untrusted advisor is refused (exit 11)', async () => {
  const cfg = parseConfig('models:\n  gpt: { provider: codex-cli, id: s, trust: untrusted }\nroles:\n  advisor: [gpt]\n');
  const err = sink();
  const code = await runConsult({ stdin: 'q\nc', flags: { sensitive: true }, config: cfg, deps: okDeps(), out: sink().fn, err: err.fn });
  assert.equal(code, 11);
  assert.match(err.text(), /refused-by-policy/);
});

// ---- unknown-flag / unknown-key rejection (fail-closed) --------------------

test('parseArgs collects an unknown flag instead of swallowing it as a positional', () => {
  // GIVEN a typo'd flag, WHEN parsing, THEN it lands in `unknown` (not `_`) so checkArgs can reject it.
  const { flags } = parseArgs(['consult', '--sensitve']);
  assert.deepEqual(flags.unknown, ['--sensitve']);
  assert.deepEqual(flags._, []);
});

test('parseArgs does not let a value flag swallow a following flag', () => {
  // GIVEN `--config` with no path before `--json`, WHEN parsing, THEN --config is flagged missing and
  // --json is still parsed (so an error can still be emitted as JSON).
  const { flags } = parseArgs(['consult', '--config', '--json']);
  assert.deepEqual(flags.missingValue, ['--config']);
  assert.equal(flags.json, true);
  assert.equal(flags.config, undefined);
});

test('checkArgs rejects the --sensitve typo as a usage error (exit 10) — the security fail-open', () => {
  // GIVEN a mistyped --sensitive, WHEN validating, THEN it is a USAGE error, NOT silently ignored —
  // otherwise a request meant to be sensitive would go to an untrusted third-party advisor.
  const { command, flags } = parseArgs(['consult', '--sensitve']);
  const e = checkArgs(command, flags);
  assert.equal(e?.kind, 'usage');
  assert.equal(e?.exitCode, 10);
  assert.match(e.message, /--sensitve/);
});

test('checkArgs rejects a flag valid for another command', () => {
  // GIVEN --panel (a consult flag) passed to doctor, WHEN validating, THEN usage error.
  const { command, flags } = parseArgs(['doctor', '--panel']);
  const e = checkArgs(command, flags);
  assert.equal(e?.exitCode, 10);
  assert.match(e.message, /--panel/);
});

test('checkArgs rejects a missing flag value', () => {
  const { command, flags } = parseArgs(['consult', '--task-id']);
  const e = checkArgs(command, flags);
  assert.equal(e?.exitCode, 10);
  assert.match(e.message, /--task-id requires a value/);
});

test('checkArgs rejects a stray positional and points to stdin for consult', () => {
  const { command, flags } = parseArgs(['consult', 'my question here']);
  const e = checkArgs(command, flags);
  assert.equal(e?.exitCode, 10);
  assert.match(e.message, /STDIN/);
});

test('checkArgs accepts a valid flag set', () => {
  const { command, flags } = parseArgs(['consult', '--sensitive', '--json', '--task-id', 'T1']);
  assert.equal(checkArgs(command, flags), null);
});

// ---- malformed JSON stdin must be a usage error, NOT a paid provider call --

test('parseStdin: malformed JSON (looks like JSON) throws USAGE, not a plain-text fallthrough', () => {
  // GIVEN a truncated JSON packet, WHEN parsing stdin, THEN it is a usage error — previously it fell
  // through to line-based parsing and billed a real provider call for the garbled text.
  assert.throws(() => parseStdin('{"question": "unterminated'), (e) => e.kind === 'usage' && e.exitCode === 10);
});

test('parseStdin: JSON with an unknown key is rejected (no silent drop of e.g. sensitive)', () => {
  assert.throws(() => parseStdin('{"question":"q","sensitve":true}'), (e) => e.kind === 'usage' && /sensit/.test(e.message));
});

test('parseStdin: a non-string sourcePath is rejected (never stringified to "[object Object]")', () => {
  // GIVEN a JSON packet whose sourcePath is an object, WHEN parsing, THEN it is a usage error — not
  // silently String()'d to "[object Object]", which would defeat a sensitive_paths rule. (review find)
  assert.throws(() => parseStdin('{"question":"q","sourcePath":{}}'), (e) => e.kind === 'usage' && /sourcePath/.test(e.message));
});

test('parseStdin: only a leading { signals JSON — a leading [ is a plain-text question', () => {
  // The protocol is: `{` = JSON packet, anything else = first line is the question. A question that
  // happens to start with `[` must NOT be misread as a malformed JSON array and rejected.
  assert.deepEqual(parseStdin('[urgent] why does it fail?'), { question: '[urgent] why does it fail?', context: '', sourcePath: null });
});

test('runConsult: malformed JSON stdin returns exit 10 BEFORE any provider call', async () => {
  // GIVEN malformed JSON on stdin, WHEN consulting, THEN exit 10 (usage) and the provider deps are
  // never invoked — no money is spent. Previously this exited 12 (a real, billed provider error).
  let invoked = false;
  const deps = { httpPostJson: async () => { invoked = true; return {}; }, runWithStdin: async () => { invoked = true; return { code: 0, stdout: REC, stderr: '', timedOut: false }; } };
  const err = sink();
  const code = await runConsult({ stdin: '{"question": "unterminated', flags: { json: true }, config: CFG, deps, out: sink().fn, err: err.fn });
  assert.equal(code, 10);
  assert.equal(invoked, false);
  assert.equal(JSON.parse(err.text()).error.kind, 'usage');
});

test('runConsult: provider error returns exit 12, --json error shape', async () => {
  const badDeps = { httpPostJson: async () => { throw new Error('down'); }, runWithStdin: async () => ({ code: 1, stdout: '', stderr: 'x', timedOut: false }) };
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
  assert.deepEqual(obj.roles.advisor, ['adv', 'gpt']);
  assert.equal(obj.models.adv.trust, 'trusted');
});

test('runDoctor prints resolved roles and flags a sensitive-refused config', async () => {
  const cfg = parseConfig('models:\n  gpt: { provider: codex-cli, id: s, trust: untrusted }\nroles:\n  advisor: [gpt]\n');
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

// ---- ok-unverified (fix 1): doctor must not report a bare 'ok' for an unverified model id --------

test('cliStatus reports ok-unverified when the binary is on PATH (the model id itself is not validated)', () => {
  const s = cliStatus('node', {}, null);
  assert.equal(s.status, 'ok-unverified');
  assert.match(s.detail, /model id not verified/);
});

test('cliStatus reports not-on-path when the binary is missing', () => {
  const s = cliStatus('definitely-not-a-real-binary-xyz123', {}, null);
  assert.equal(s.status, 'not-on-path');
});

test('isUsable treats ok and ok-unverified as usable; other statuses are not', () => {
  assert.equal(isUsable('ok'), true);
  assert.equal(isUsable('ok-unverified'), true);
  assert.equal(isUsable('model-missing'), false);
  assert.equal(isUsable('egress-blocked'), false);
  assert.equal(isUsable('not-authed'), false);
  assert.equal(isUsable(undefined), false);
});

test('ollamaStatus: a pulled tag is ok', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.1:8b', size: 100 }] }) });
  try {
    const s = await ollamaStatus('http://localhost:11434', 'llama3.1:8b');
    assert.equal(s.status, 'ok');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ollamaStatus: a :cloud tag is ok-unverified even when absent from the local tag list', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.1:8b' }] }) });
  try {
    const s = await ollamaStatus('http://localhost:11434', 'glm-5.2:cloud');
    assert.equal(s.status, 'ok-unverified');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('ollamaStatus: a missing non-cloud tag is still model-missing', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.1:8b' }] }) });
  try {
    const s = await ollamaStatus('http://localhost:11434', 'mistral:7b');
    assert.equal(s.status, 'model-missing');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runDoctor: ok-unverified counts as usable — a CLI-only advisor chain does not trip PROVIDER_ERROR (regression)', async () => {
  const cfg = parseConfig('models:\n  a: { provider: codex-cli, id: gpt-5-codex, trust: untrusted }\nroles:\n  advisor: [a]\n');
  const out = sink();
  const probe = async () => ({ status: 'ok-unverified', detail: 'on PATH' });
  const code = await runDoctor({ flags: {}, config: cfg, out: out.fn, err: sink().fn, probe });
  assert.equal(code, 0);
  assert.doesNotMatch(out.text(), /no usable advisor/);
});

test('runDoctor: the ok-unverified footnote appears when a model reports it, and is absent otherwise', async () => {
  const cfg = parseConfig('models:\n  a: { provider: codex-cli, id: gpt-5-codex, trust: untrusted }\nroles:\n  advisor: [a]\n');

  const outUnverified = sink();
  const probeUnverified = async () => ({ status: 'ok-unverified', detail: 'on PATH' });
  const codeUnverified = await runDoctor({ flags: {}, config: cfg, out: outUnverified.fn, err: sink().fn, probe: probeUnverified });
  assert.equal(codeUnverified, 0);
  assert.match(outUnverified.text(), /ok-unverified: reachable and usable/);

  const outVerified = sink();
  const probeVerified = async () => ({ status: 'ok', detail: 'model pulled' });
  const codeVerified = await runDoctor({ flags: {}, config: cfg, out: outVerified.fn, err: sink().fn, probe: probeVerified });
  assert.equal(codeVerified, 0);
  assert.doesNotMatch(outVerified.text(), /ok-unverified: reachable and usable/);
});

// ---- ollama tag detection (fix 2): init should offer a model the user actually has ---------------

test('pickOllamaTag picks the largest non-cloud, non-embedding tag', async () => {
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: 'bge-m3:latest', size: 500 },
        { name: 'glm-5.2:cloud', size: 900 },
        { name: 'gemma3:4b', size: 3000 },
        { name: 'gemma4:31b-mlx', size: 18000 },
        { name: 'nomic-embed-text:latest', size: 400 },
      ],
    }),
  });
  assert.equal(await pickOllamaTag(mockFetch), 'gemma4:31b-mlx');
});

test('pickOllamaTag returns null when the tag list is empty', async () => {
  const mockFetch = async () => ({ ok: true, json: async () => ({ models: [] }) });
  assert.equal(await pickOllamaTag(mockFetch), null);
});

test('pickOllamaTag returns null on a non-ok HTTP response', async () => {
  const mockFetch = async () => ({ ok: false });
  assert.equal(await pickOllamaTag(mockFetch), null);
});

test('pickOllamaTag returns null when the request fails or times out', async () => {
  const mockFetch = async () => { throw new Error('AbortError: The operation was aborted'); };
  assert.equal(await pickOllamaTag(mockFetch), null);
});

test('pickOllamaTag rejects an embedding model by its capabilities array, not just its name', async () => {
  // GIVEN an embedding model whose name has no embed/bge marker, WHEN picking, THEN capabilities
  // reject it and a smaller general model wins.
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: 'mxbai:latest', size: 9000, capabilities: ['embedding'] },
        { name: 'gemma3:4b', size: 3000, capabilities: ['completion'] },
      ],
    }),
  });
  assert.equal(await pickOllamaTag(mockFetch), 'gemma3:4b');
});

test('pickOllamaTag prefers a tools-capable general model over a larger vision or domain model', async () => {
  // GIVEN a large vision model, a large domain model, and a smaller general tools model, WHEN picking,
  // THEN the general tools model wins despite being smaller (capability score beats raw size).
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: 'qwen2.5vl:7b', size: 6000, capabilities: ['vision', 'completion'] },
        { name: 'medgemma:27b', size: 17000, capabilities: ['completion'] },
        { name: 'gemma4:31b-mlx', size: 5000, capabilities: ['completion', 'tools', 'thinking'] },
      ],
    }),
  });
  assert.equal(await pickOllamaTag(mockFetch), 'gemma4:31b-mlx');
});

test('pickOllamaTag falls back to size order when no model reports capabilities (older daemon)', async () => {
  // GIVEN a daemon that omits `capabilities` (omitempty on older Ollama), WHEN picking, THEN the old
  // largest-non-embedding heuristic still applies — capability filtering must never empty a good list.
  const mockFetch = async () => ({
    ok: true,
    json: async () => ({
      models: [
        { name: 'gemma3:4b', size: 3000 },
        { name: 'gemma4:31b-mlx', size: 18000 },
      ],
    }),
  });
  assert.equal(await pickOllamaTag(mockFetch), 'gemma4:31b-mlx');
});

test('pickCodexModel reads the top-level model from $CODEX_HOME/config.toml and ignores table keys', async () => {
  // GIVEN a codex config with a top-level model and a later [profiles.x] model, WHEN reading, THEN the
  // top-level model is returned (never a broken hardcoded default) and the table key is not misread.
  const { pickCodexModel } = await import('../src/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-'));
  fs.writeFileSync(path.join(dir, 'config.toml'), 'model = "my-account-model"\n[profiles.other]\nmodel = "should-not-win"\n');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    assert.equal(pickCodexModel(), 'my-account-model');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pickCodexModel returns null when config.toml is absent (so init scaffolds codex commented-out)', async () => {
  const { pickCodexModel } = await import('../src/cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexhome-empty-'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    assert.equal(pickCodexModel(), null);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- doctor honesty: HTTP adapters report ok-unverified (blocker 2) --------

test('httpAuthedStatus reports ok-unverified (reachable + credential present, model id NOT verified)', async () => {
  // GIVEN a reachable HTTP provider with the credential env set, WHEN probing, THEN the status is
  // ok-unverified — the model id was never sent to the provider, so a wrong id fails at consult time,
  // not here. PR #10 fixed this for CLI/Ollama but missed the HTTP adapters.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  process.env.__TEST_KEY = 'x';
  try {
    const s = await httpAuthedStatus({ apiKeyEnv: '__TEST_KEY' }, 'https://api.example.com', '__TEST_KEY', '/v1/models');
    assert.equal(s.status, 'ok-unverified');
    assert.match(s.detail, /not verified/i);
    assert.equal(isUsable(s.status), true);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.__TEST_KEY;
  }
});

test('httpAuthedStatus still reports not-authed when no credential is present', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200 });
  try {
    const s = await httpAuthedStatus({ apiKeyEnv: '__NOPE_KEY' }, 'https://api.example.com', '__NOPE_KEY', '/v1/models');
    assert.equal(s.status, 'not-authed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- --task-id state file: a COST control, must fail closed & atomic -------

function tmpStatePath(tag) {
  return path.join(os.tmpdir(), `consultum-test-state-${tag}-${process.pid}.json`);
}

test('readState: a missing file is a fresh budget ({}) — the normal first consult', () => {
  const p = tmpStatePath('missing');
  try { fs.unlinkSync(p); } catch { /* ok */ }
  assert.deepEqual(readState(p), {});
});

test('readState: a CORRUPT file fails closed (throws) instead of silently resetting the budget', () => {
  // GIVEN a garbled state file, WHEN reading, THEN it throws rather than returning {} — a silent reset
  // would grant an unlimited fresh consult budget (a cost control) on a tampered/corrupt file.
  const p = tmpStatePath('corrupt');
  fs.writeFileSync(p, 'not json at all');
  try {
    assert.throws(() => readState(p), (e) => e.kind === 'usage' && /corrupt/i.test(e.message));
  } finally {
    fs.unlinkSync(p);
  }
});

test('readState: a non-object JSON (array/scalar) is rejected', () => {
  const p = tmpStatePath('nonobj');
  fs.writeFileSync(p, '[1,2,3]');
  try {
    assert.throws(() => readState(p), (e) => e.kind === 'usage');
  } finally {
    fs.unlinkSync(p);
  }
});

test('writeState round-trips through readState and writes 0600, atomically', () => {
  const p = tmpStatePath('roundtrip');
  try {
    writeState(p, { T1: ['abc'] });
    assert.deepEqual(readState(p), { T1: ['abc'] });
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(p).mode & 0o777, 0o600);
    }
    // no leftover temp file
    assert.equal(fs.existsSync(`${p}.${process.pid}.tmp`), false);
  } finally {
    try { fs.unlinkSync(p); } catch { /* ok */ }
  }
});

test('acquireStateLock is exclusive: a second acquire waits until the first releases', async () => {
  // GIVEN one holder, WHEN a second acquire is attempted, THEN it does not resolve until release —
  // this exclusivity is what makes the concurrent budget check-and-reserve atomic.
  const p = tmpStatePath('lock');
  try { fs.unlinkSync(`${p}.lock`); } catch { /* ok */ }
  const release1 = await acquireStateLock(p);
  let secondAcquired = false;
  const second = acquireStateLock(p).then((r) => { secondAcquired = true; return r; });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(secondAcquired, false, 'second acquire must block while the lock is held');
  release1();
  const release2 = await second;
  assert.equal(secondAcquired, true);
  release2();
  assert.equal(fs.existsSync(`${p}.lock`), false);
});

test('runConsult with --task-id enforces max_consults_per_task across persisted state (exit 13)', async () => {
  // GIVEN a task at its consult cap in the persisted state file, WHEN consulting again with the same
  // --task-id, THEN it is refused (limit-exceeded, exit 13) — the file-backed budget is honoured.
  const taskId = `captest-${process.pid}`;
  const statePath = path.join(os.tmpdir(), `consultum-state-${taskId}.json`);
  const cfg = parseConfig(`
models:
  adv: { provider: ollama, id: adv-model, trust: trusted }
roles:
  advisor: [adv]
policy:
  default_sensitive: false
  max_consults_per_task: 1
`);
  try { fs.unlinkSync(statePath); } catch { /* ok */ }
  try {
    const first = await runConsult({ stdin: 'q1\nc1', flags: { taskId }, config: cfg, deps: okDeps(), out: sink().fn, err: sink().fn });
    assert.equal(first, 0);
    const err = sink();
    const second = await runConsult({ stdin: 'q2\nc2', flags: { taskId }, config: cfg, deps: okDeps(), out: sink().fn, err: err.fn });
    assert.equal(second, 13);
    assert.match(err.text(), /limit-exceeded|max_consults_per_task/);
  } finally {
    try { fs.unlinkSync(statePath); } catch { /* ok */ }
    try { fs.unlinkSync(`${statePath}.lock`); } catch { /* ok */ }
  }
});

test('defaultDetect --sandbox never makes the ollama network probe', async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (...args) => { called = true; return realFetch(...args); };
  try {
    const detected = await defaultDetect({ sandbox: true });
    assert.equal(detected.ollamaModel, null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('generateStarterConfig uses detected.ollamaModel when present, falls back to the placeholder otherwise', () => {
  const withTag = generateStarterConfig({ ollama: true, ollamaModel: 'gemma4:31b-mlx' });
  assert.match(withTag, /id: gemma4:31b-mlx/);
  const withoutTag = generateStarterConfig({ ollama: true, ollamaModel: null });
  assert.match(withoutTag, /id: llama3\.1:8b/);
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

test('runInit --sandbox --print includes the config-outside-workspace guidance path', async () => {
  const out = sink();
  const code = await runInit({ flags: { sandbox: true, print: true }, out: out.fn, err: sink().fn, detect: () => ({}), writeFile: () => {} });
  assert.equal(code, 0);
  assert.match(out.text(), /anthropic-api/);
});

test('generateStarterConfig builds an ordered advisor chain from detected providers', () => {
  // GIVEN codex is detected WITH a known model id (from ~/.codex/config.toml), WHEN scaffolding,
  // THEN codex is an active advisor using that id.
  const all = generateStarterConfig({ claude: true, codex: true, codexModel: 'gpt-5.6-sol', ollama: true });
  assert.match(all, /advisor: \[claude, codex\]/);
  assert.match(all, /id: gpt-5\.6-sol/);
  assert.match(all, /provider: anthropic-cli/);
  const none = generateStarterConfig({ claude: false, codex: false, ollama: false });
  assert.match(none, /advisor: \[local\]/);
});

test('generateStarterConfig comments codex OUT when no account model id is known (never scaffolds a broken default)', () => {
  // GIVEN codex is on PATH but no model id was found in ~/.codex/config.toml, WHEN scaffolding,
  // THEN codex is left commented (not an active advisor) and no `gpt-5-codex` literal is emitted,
  // because that id is rejected on a ChatGPT account and would fail at consult time.
  const cfg = generateStarterConfig({ claude: true, codex: true, ollama: false });
  assert.doesNotMatch(cfg, /gpt-5-codex/);
  assert.match(cfg, /# codex: \{ provider: codex-cli/);
  assert.match(cfg, /advisor: \[claude\]/);
});

test('runInit uses the real provider detector without crashing (regression: probeOnPath rename)', async () => {
  const out = sink();
  const code = await runInit({ flags: { print: true }, out: out.fn, err: sink().fn }); // no detect injected -> defaultDetect
  assert.equal(code, 0);
  assert.match(out.text(), /models:/);
});

test('runInit --print emits a starter config without writing', async () => {
  const out = sink();
  let wrote = false;
  const code = await runInit({ flags: { print: true }, out: out.fn, err: sink().fn, detect: () => ({ claude: true, codex: false, ollama: true }), writeFile: () => { wrote = true; } });
  assert.equal(code, 0);
  assert.equal(wrote, false);
  assert.match(out.text(), /models:/);
});

test('runInit --sandbox writes OUTSIDE the workspace (XDG), not ./consultum.yaml', async () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/tmp/consultum-xdgtest';
  try {
    let written = null;
    let mkdirp = null;
    const code = await runInit({
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
    assert.match(written, /\/tmp\/consultum-xdgtest\/consultum\/config\.yaml$/);
    assert.doesNotMatch(written, /\/work\//);
    assert.match(mkdirp, /\/tmp\/consultum-xdgtest\/consultum$/);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test('runInit refuses to overwrite an existing config without --force', async () => {
  const err = sink();
  const code = await runInit({ flags: {}, out: sink().fn, err: err.fn, detect: () => ({ ollama: true }), exists: () => true, writeFile: () => { throw new Error('should not write'); }, cwd: '/tmp' });
  assert.equal(code, 10);
  assert.match(err.text(), /already exists/);
});

test('runInit writes when target does not exist', async () => {
  const out = sink();
  let written = null;
  const code = await runInit({ flags: {}, out: out.fn, err: sink().fn, detect: () => ({ ollama: true }), exists: () => false, writeFile: (p, c) => { written = { p, c }; }, cwd: '/tmp' });
  assert.equal(code, 0);
  assert.match(written.p, /consultum\.yaml$/);
  assert.match(written.c, /models:/);
});

// --- interactive init ---------------------------------------------------------------------------
// The wizard is a terminal flow on purpose (no localhost web UI): consultum's primary caller runs
// headless, in a sandbox, over SSH or in CI, where a browser wizard is unreachable.

function scriptedAsk(answers) {
  const queue = [...answers];
  const asked = [];
  return {
    asked,
    ask: async (q) => {
      asked.push(q);
      if (!queue.length) throw new Error('wizard asked more questions than the script had answers');
      return queue.shift();
    },
  };
}

test('runInitInteractive writes a config that actually parses', async () => {
  const written = {};
  const { ask } = scriptedAsk(['n', 'n', '', 'gemma3:4b', '', '', 'n']);
  const code = await runInitInteractive({
    flags: { config: '/tmp/consultum-wizard-test.yaml' },
    out: sink().fn,
    err: sink().fn,
    ask,
    detect: () => ({ claude: true, codex: true, ollama: true }),
    writeFile: (p, c) => { written.path = p; written.content = c; },
    exists: () => false,
    mkdir: () => {},
  });
  assert.equal(code, 0);
  const parsed = parseConfig(written.content);
  assert.equal(parsed.models.local.id, 'gemma3:4b');
  assert.equal(parsed.models.local.trust, 'local');
  assert.deepEqual(parsed.roles.advisor, ['local']);
  // declining claude/codex must actually leave them out
  assert.equal(parsed.models.claude, undefined);
  assert.equal(parsed.models.codex, undefined);
});

test('runInitInteractive honours default_sensitive and an invalid trust falls back safely', async () => {
  const written = {};
  const { ask } = scriptedAsk(['', 'claude-opus-4-8', 'nonsense-trust', 'n', 'n', '', 'y']);
  await runInitInteractive({
    flags: { config: '/tmp/consultum-wizard-test2.yaml' },
    out: sink().fn,
    err: sink().fn,
    ask,
    detect: () => ({ claude: true, codex: true, ollama: true }),
    writeFile: (p, c) => { written.content = c; },
    exists: () => false,
    mkdir: () => {},
  });
  const parsed = parseConfig(written.content);
  assert.equal(parsed.models.claude.trust, 'trusted', 'an invalid trust must fall back, never be written through');
  assert.equal(parsed.policy.default_sensitive, true);
});

test('runInitInteractive refuses to clobber an existing config without --force', async () => {
  const { ask } = scriptedAsk(['n', 'n', '', '', '', '', 'n']);
  const err = sink();
  const code = await runInitInteractive({
    flags: { config: '/tmp/exists.yaml' },
    out: sink().fn,
    err: err.fn,
    ask,
    detect: () => ({ ollama: true }),
    writeFile: () => { throw new Error('must not write'); },
    exists: () => true,
    mkdir: () => {},
  });
  assert.equal(code, 10);
  assert.match(err.text(), /already exists/);
});

test('pickOllamaTag honours OLLAMA_HOST when the daemon is not on the default port', async () => {
  // GIVEN OLLAMA_HOST points at a non-default host (bare host:port, no scheme)
  // WHEN pickOllamaTag probes for installed tags
  // THEN it queries that host, not localhost:11434
  const prev = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = '10.0.0.5:9999';
  const seen = [];
  const fakeFetch = async (url) => {
    seen.push(url);
    return { ok: true, json: async () => ({ models: [{ name: 'mistral:7b', size: 4_000_000_000 }] }) };
  };
  try {
    const picked = await pickOllamaTag(fakeFetch);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'http://10.0.0.5:9999/api/tags');
    assert.equal(picked, 'mistral:7b');
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = prev;
  }
});
