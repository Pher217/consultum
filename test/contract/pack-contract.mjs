// Packed-tarball black-box contract suite — the release gate. Everything else in test/ imports
// source modules directly; this file trusts NOTHING about the source tree. It `npm pack`s the repo,
// `npm install`s the resulting tarball into a throwaway directory (exactly what a real consumer
// does), then drives the REAL installed `bin/consultum.js` as a child process and asserts every
// documented exit code and --json error shape, plus a strict `tsc` compile against the published
// types/index.d.ts. This is the only suite that would have caught: (1) an unrecognized flag silently
// falling open, (2) oversized stdin exiting 1 with prose instead of 10 with JSON, (3) `doctor`
// reporting an unverified HTTP model id as bare 'ok', (4) a stale/wrong model id shipped in
// config.example.yaml.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** @type {string | null} set in before() when the suite must be skipped (offline / npm unavailable) */
let skipReason = null;
let workDir; // throwaway npm project the tarball is installed into
let tarballPath; // absolute path to the tarball produced by `npm pack`
let binPath; // <workDir>/node_modules/.bin/consultum
let pkgRoot; // <workDir>/node_modules/consultum (the installed package root)
let cfgPath; // minimal ollama-backed config used by most consult/doctor tests

const BASE_CONFIG = `models:
  local: { provider: ollama, id: gemma3:4b, trust: local, base_url: "http://127.0.0.1:59999" }
roles:
  advisor: [local]
policy:
  default_sensitive: false
`;

function looksOffline(streams) {
  const text = `${streams.stdout || ''}\n${streams.stderr || ''}`;
  return /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|network|offline|getaddrinfo/i.test(text);
}

// Runs the INSTALLED binary as a real child process — never the source in this repo. Falls back to
// `node <binPath> ...` if the tarball-installed shim isn't directly executable (e.g. no exec bit
// on some platforms/installers), matching how a real consumer's package manager might behave.
function runCli(args, { input = '', env = {} } = {}) {
  const fullEnv = { ...process.env, ...env };
  let res = spawnSync(binPath, args, { input, env: fullEnv, encoding: 'utf8', timeout: 30_000 });
  if (res.error && res.error.code === 'ENOENT') {
    res = spawnSync(process.execPath, [binPath, ...args], { input, env: fullEnv, encoding: 'utf8', timeout: 30_000 });
  }
  return res;
}

function sanitizeTaskId(s) {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

before(() => {
  // node --test's default file discovery sweeps up ANY file nested under a directory named `test`
  // — including this one — so a bare `node --test` (what the fast unit suite's `test` script runs)
  // would otherwise also run the full pack/install/tsc cycle below on every unit-test invocation.
  // Require an explicit opt-in env var, set only by the `test:contract` script, so accidental
  // discovery is a fast no-op skip instead of a slow (and network-dependent) surprise.
  if (process.env.CONSULTUM_RUN_CONTRACT !== '1') {
    skipReason = 'set CONSULTUM_RUN_CONTRACT=1 (via `npm run test:contract`) to run the packed-tarball contract suite';
    return;
  }

  // 1) Pack the repo into a tarball. `npm pack --json` gives us the exact filename, independent of
  //    how many stdout lines npm decides to print.
  const packRes = spawnSync('npm', ['pack', '--json'], { cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000 });
  if (packRes.status !== 0) {
    if (looksOffline(packRes)) { skipReason = 'npm pack failed (offline): ' + (packRes.stderr || '').trim(); return; }
    throw new Error(`npm pack failed (exit ${packRes.status}): ${packRes.stderr}`);
  }
  let packInfo;
  try {
    packInfo = JSON.parse(packRes.stdout)[0];
  } catch (e) {
    throw new Error(`npm pack --json produced unparsable output: ${e.message}\n${packRes.stdout}`);
  }
  tarballPath = path.join(REPO_ROOT, packInfo.filename);
  assert.ok(fs.existsSync(tarballPath), `expected tarball at ${tarballPath}`);

  // 2) Install the tarball into a throwaway npm project — the same path a real consumer takes.
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consultum-contract-'));
  const initRes = spawnSync('npm', ['init', '-y'], { cwd: workDir, encoding: 'utf8', timeout: 30_000 });
  if (initRes.status !== 0) throw new Error(`npm init failed in ${workDir}: ${initRes.stderr}`);

  const installRes = spawnSync(
    'npm',
    ['install', tarballPath, '--no-save', '--no-audit', '--no-fund'],
    { cwd: workDir, encoding: 'utf8', timeout: 120_000 },
  );
  if (installRes.status !== 0) {
    if (looksOffline(installRes)) { skipReason = 'npm install failed (offline): ' + (installRes.stderr || '').trim(); return; }
    throw new Error(`npm install of packed tarball failed (exit ${installRes.status}): ${installRes.stderr}`);
  }

  pkgRoot = path.join(workDir, 'node_modules', 'consultum');
  binPath = path.join(workDir, 'node_modules', '.bin', 'consultum');
  assert.ok(fs.existsSync(pkgRoot), `expected installed package at ${pkgRoot}`);
  assert.ok(fs.existsSync(binPath), `expected installed bin at ${binPath}`);

  cfgPath = path.join(workDir, 'cfg.yaml');
  fs.writeFileSync(cfgPath, BASE_CONFIG, 'utf8');
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  if (tarballPath && fs.existsSync(tarballPath)) fs.rmSync(tarballPath, { force: true });
});

// ---- consult: argument validation (before any provider is ever contacted) -------------------

test('consult --sensitve (typo) exits 10 and names the bad flag', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN a typo'd --sensitve flag WHEN consult runs THEN it is a hard usage error, not a silent
  // fail-open to a non-sensitive request.
  const res = runCli(['consult', '--sensitve'], { input: 'q', env: { CONSULTUM_CONFIG: cfgPath } });
  assert.equal(res.status, 10);
  assert.match(res.stderr, /unknown flag/);
  assert.match(res.stderr, /--sensitve/);
});

test('consult --bogus exits 10 and names the bad flag', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN an unrecognized flag WHEN consult runs THEN exit 10 and the flag is named in stderr.
  const res = runCli(['consult', '--bogus'], { input: 'q', env: { CONSULTUM_CONFIG: cfgPath } });
  assert.equal(res.status, 10);
  assert.match(res.stderr, /--bogus/);
});

test('doctor --panel exits 10 (flag not valid for this command)', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN --panel (a consult-only flag) WHEN doctor runs THEN it is rejected, not silently ignored.
  const res = runCli(['doctor', '--panel'], { env: { CONSULTUM_CONFIG: cfgPath } });
  assert.equal(res.status, 10);
  assert.match(res.stderr, /--panel/);
});

test('consult --json with malformed JSON stdin exits 10 with a structured usage error, no provider call', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN unterminated JSON on stdin WHEN consult --json runs THEN it fails as USAGE (10), not
  // PROVIDER_ERROR (12) — proving the parse failure is caught before any advisor is contacted.
  const res = runCli(['consult', '--json'], { input: '{"question": "unterminated', env: { CONSULTUM_CONFIG: cfgPath } });
  assert.equal(res.status, 10);
  const parsed = JSON.parse(res.stderr.trim());
  assert.equal(parsed.error.kind, 'usage');
});

test('consult --json with an unknown JSON key exits 10, kind usage, message names the key', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN a stdin JSON object with an unrecognized key ("sensitve") WHEN consult --json runs
  // THEN it is rejected as usage and the offending key is named.
  const res = runCli(['consult', '--json'], {
    input: JSON.stringify({ question: 'q', sensitve: true }),
    env: { CONSULTUM_CONFIG: cfgPath },
  });
  assert.equal(res.status, 10);
  const parsed = JSON.parse(res.stderr.trim());
  assert.equal(parsed.error.kind, 'usage');
  assert.match(parsed.error.message, /sensitve/);
});

test('consult --json with oversized stdin exits 10 with structured usage error mentioning the limit', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN >1MB of stdin WHEN consult --json runs THEN it fails closed as a structured USAGE error
  // (10), not the pre-fix behavior of exit 1 with unstructured prose.
  const oversized = 'a'.repeat(1_200_000);
  const res = runCli(['consult', '--json'], { input: oversized, env: { CONSULTUM_CONFIG: cfgPath } });
  assert.equal(res.status, 10);
  const parsed = JSON.parse(res.stderr.trim());
  assert.equal(parsed.error.kind, 'usage');
  assert.match(parsed.error.message, /exceeds/);
});

test('consult with empty/whitespace stdin exits 10 (no question)', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN whitespace-only stdin WHEN consult runs THEN exit 10 (no question to consult on).
  const res = runCli(['consult'], { input: '   ', env: { CONSULTUM_CONFIG: cfgPath } });
  assert.equal(res.status, 10);
});

// ---- consult: library-mode consult-limit enforcement ------------------------------------------

test('consult --task-id exits 13 (limit-exceeded) once the cap is already reached', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN a pre-seeded state file that already recorded one consult for task 'CAP', and a config
  // with policy.max_consults_per_task: 1, WHEN a single further consult runs for the same task-id
  // THEN it is rejected as LIMIT_EXCEEDED (13) — without needing a real provider round-trip to get
  // there, since the cap check happens before any advisor is contacted.
  //
  // The CLI is stateless per-invocation; --task-id state lives in a JSON file at
  // <os.tmpdir()>/consultum-state-<sanitized task-id>.json (sanitize: non [A-Za-z0-9_.-] -> '_').
  // We pre-write that file with one prior consult signature already recorded, so the very first
  // `consult --task-id CAP` we run here already finds the cap (1) reached.
  const capCfgPath = path.join(workDir, 'cap-cfg.yaml');
  fs.writeFileSync(
    capCfgPath,
    `models:
  local: { provider: ollama, id: gemma3:4b, trust: local, base_url: "http://127.0.0.1:59999" }
roles:
  advisor: [local]
policy:
  default_sensitive: false
  max_consults_per_task: 1
`,
    'utf8',
  );
  const taskId = 'CAP';
  const statePath = path.join(os.tmpdir(), `consultum-state-${sanitizeTaskId(taskId)}.json`);
  const lockPath = `${statePath}.lock`;
  fs.writeFileSync(statePath, JSON.stringify({ [taskId]: ['deadbeefdeadbeef'] }), 'utf8');

  try {
    const res = runCli(['consult', '--task-id', taskId, '--json'], {
      input: 'a brand new question never asked before',
      env: { CONSULTUM_CONFIG: capCfgPath },
    });
    assert.equal(res.status, 13);
    const parsed = JSON.parse(res.stderr.trim());
    assert.equal(parsed.error.kind, 'limit-exceeded');
  } finally {
    fs.rmSync(statePath, { force: true });
    fs.rmSync(lockPath, { force: true });
  }
});

// ---- doctor: HTTP-model honesty (blocker 2 regression guard) ----------------------------------

test('doctor reports an HTTP openai model as ok-unverified when credentialed, exit 0', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN an openai model with FAKE set (credential present, never sent) WHEN doctor runs THEN the
  // model's line is reported ok-unverified (never bare 'ok' — the id itself was never confirmed
  // against the provider), and doctor still exits 0 because that model counts as usable.
  const httpCfgPath = path.join(workDir, 'http-cfg.yaml');
  fs.writeFileSync(
    httpCfgPath,
    `models:
  gpt: { provider: openai, id: gpt-4o, trust: untrusted, api_key_env: FAKE }
roles:
  advisor: [gpt]
policy:
  default_sensitive: false
`,
    'utf8',
  );
  const res = runCli(['doctor'], { env: { CONSULTUM_CONFIG: httpCfgPath, FAKE: 'x' } });
  const gptLine = res.stdout.split('\n').find((l) => l.trim().startsWith('gpt '));
  assert.ok(gptLine, `expected a 'gpt' line in doctor output:\n${res.stdout}`);
  assert.match(gptLine, /ok-unverified/);
  assert.match(res.stdout, /not verified/);
  assert.equal(res.status, 0);
});

test('doctor reports the same HTTP openai model as not-authed when its credential env is unset, exit 12', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN the same openai model but FAKE unset WHEN doctor runs THEN the model's line is
  // not-authed, and since no advisor in the chain is usable, doctor exits PROVIDER_ERROR (12).
  const httpCfgPath = path.join(workDir, 'http-cfg-noauth.yaml');
  fs.writeFileSync(
    httpCfgPath,
    `models:
  gpt: { provider: openai, id: gpt-4o, trust: untrusted, api_key_env: FAKE }
roles:
  advisor: [gpt]
policy:
  default_sensitive: false
`,
    'utf8',
  );
  const env = { ...process.env, CONSULTUM_CONFIG: httpCfgPath };
  delete env.FAKE;
  const res = runCli(['doctor'], { env });
  const gptLine = res.stdout.split('\n').find((l) => l.trim().startsWith('gpt '));
  assert.ok(gptLine, `expected a 'gpt' line in doctor output:\n${res.stdout}`);
  assert.match(gptLine, /not-authed/);
  assert.equal(res.status, 12);
});

// ---- config / --version / --help / bare invocation ---------------------------------------------

test('config command exits 0 and emits parseable JSON matching the loaded config', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN the minimal config WHEN `consultum config` runs THEN it exits 0 and stdout is valid JSON
  // whose models.local.id round-trips exactly.
  const res = runCli(['config'], { env: { CONSULTUM_CONFIG: cfgPath } });
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.models.local.id, 'gemma3:4b');
});

test('--version exits 0 and prints a semver', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN --version WHEN the CLI runs THEN it exits 0 and prints a x.y.z version string.
  const res = runCli(['--version']);
  assert.equal(res.status, 0);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('--help exits 0 and prints usage', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN --help WHEN the CLI runs THEN it exits 0 and prints the Usage: banner.
  const res = runCli(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
});

test('bare invocation (no command) exits 10', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN no command at all WHEN the CLI runs THEN it exits 10 (usage), not 0.
  const res = runCli([]);
  assert.equal(res.status, 10);
});

// ---- shipped config.example.yaml + generateStarterConfig (blocker 3 regression guards) --------

test('installed config.example.yaml has the correct advisor model id, not the mangled one', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN the INSTALLED package's config.example.yaml WHEN read from node_modules THEN it contains
  // the correct `claude-opus-4-8` id and never the doubled `claude-claude-4-8` regression.
  const examplePath = path.join(pkgRoot, 'config.example.yaml');
  const content = fs.readFileSync(examplePath, 'utf8');
  assert.match(content, /claude-opus-4-8/);
  assert.doesNotMatch(content, /claude-claude-4-8/);
});

test('installed src/cli.js does not assign a hardcoded gpt-5-codex model id (comments only)', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN the INSTALLED package's src/cli.js WHEN scanned for an active `id: gpt-5-codex` field
  // assignment THEN there are none — any mention of gpt-5-codex is prose/comment, not a starter
  // config default (a ChatGPT-tier id that is rejected on other account tiers).
  const cliJsPath = path.join(pkgRoot, 'src', 'cli.js');
  const content = fs.readFileSync(cliJsPath, 'utf8');
  const activeAssignments = content.match(/id:\s*gpt-5-codex/g) || [];
  assert.equal(activeAssignments.length, 0, `found active 'id: gpt-5-codex' assignment(s) in installed src/cli.js`);
});

// ---- TypeScript compile against the published types --------------------------------------------

test('ts-consumer.ts compiles against the published types/index.d.ts with tsc --strict', (t) => {
  if (skipReason) return t.skip(skipReason);
  // GIVEN a TS consumer importing from the installed 'consultum' package (never from repo source)
  // WHEN compiled with `tsc --noEmit --strict` from inside the throwaway install dir (so NodeNext
  // resolution finds node_modules/consultum/types/index.d.ts the same way a real consumer would)
  // THEN tsc exits 0.
  const tsConsumerSrc = fs.readFileSync(path.join(HERE, 'ts-consumer.ts'), 'utf8');
  const tsconfigSrc = fs.readFileSync(path.join(HERE, 'tsconfig.json'), 'utf8');
  fs.writeFileSync(path.join(workDir, 'ts-consumer.ts'), tsConsumerSrc, 'utf8');
  fs.writeFileSync(path.join(workDir, 'tsconfig.json'), tsconfigSrc, 'utf8');

  const tscPath = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc');
  const res = spawnSync(tscPath, ['--noEmit', '--strict', '-p', path.join(workDir, 'tsconfig.json')], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(res.status, 0, `tsc failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`);
});
