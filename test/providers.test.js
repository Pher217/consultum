import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProvider } from '../src/providers/index.js';

function credFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'askup-p-'));
  const p = path.join(dir, 'cred');
  fs.writeFileSync(p, content);
  if (process.platform !== 'win32') fs.chmodSync(p, 0o600);
  return p;
}

// Contract tests run with NO live provider: runtime primitives are injected as fakes that record
// their calls, so we can assert the security invariants (no tools by default, prompt off argv,
// timeout forwarded, empty output surfaced as an error, stall fails fast).

const SENTINEL = 'SENTINEL_PROMPT_do_not_leak_to_argv';

function fakeDeps({ noStdin, withStdin, http } = {}) {
  const calls = { runNoStdin: [], runWithStdin: [], httpPostJson: [] };
  return {
    calls,
    runNoStdin: async (cmd, args, opts) => {
      calls.runNoStdin.push({ cmd, args, opts });
      return (noStdin ?? (() => ({ code: 0, stdout: 'advice', stderr: '', timedOut: false })))();
    },
    runWithStdin: async (cmd, args, opts) => {
      calls.runWithStdin.push({ cmd, args, opts });
      return (withStdin ?? (() => ({ code: 0, stdout: 'advice', stderr: '', timedOut: false })))();
    },
    httpPostJson: async (url, body, opts) => {
      calls.httpPostJson.push({ url, body, opts });
      return (http ?? (() => ({ message: { content: 'advice' } })))();
    },
  };
}

const model = (over) => ({ name: 'm', provider: 'ollama', id: 'x', trust: 'trusted', baseUrl: null, apiKeyEnv: null, timeoutMs: null, tools: null, ...over });

// ---- anthropic-cli ---------------------------------------------------------

test('anthropic-cli: NO tools are granted by default and the prompt never touches argv', async () => {
  const deps = fakeDeps();
  const p = createProvider(model({ provider: 'anthropic-cli', id: 'claude-x' }), deps);
  const out = await p.invoke(SENTINEL, { timeoutMs: 5000 });
  assert.equal(out.text, 'advice');
  const call = deps.calls.runWithStdin[0];
  const argstr = call.args.join(' ');
  // prompt is on stdin, not argv
  assert.equal(call.opts.input, SENTINEL);
  assert.ok(!argstr.includes(SENTINEL), 'prompt must not appear in argv');
  // no tools reachable: empty allowlist, and none of the read/mutate tools named
  assert.ok(call.args.includes('--tools'));
  const toolsVal = call.args[call.args.indexOf('--tools') + 1];
  assert.equal(toolsVal, '');
  for (const t of ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']) assert.ok(!argstr.includes(t));
  assert.ok(argstr.includes('--permission-mode plan'));
  // timeout forwarded
  assert.equal(call.opts.timeoutMs, 5000);
});

test('anthropic-cli: opt-in tools are scoped to configured allowlist + dirs', async () => {
  const deps = fakeDeps();
  const p = createProvider(model({ provider: 'anthropic-cli', id: 'c', tools: { allow: ['Read', 'Grep'], dirs: ['./ctx'] } }), deps);
  await p.invoke('q');
  const argstr = deps.calls.runWithStdin[0].args.join(' ');
  assert.ok(argstr.includes('--tools Read,Grep'));
  assert.ok(argstr.includes('--add-dir ./ctx'));
});

test('anthropic-cli: empty output is an error, not a silent success', async () => {
  const deps = fakeDeps({ withStdin: () => ({ code: 0, stdout: '   ', stderr: '', timedOut: false }) });
  const p = createProvider(model({ provider: 'anthropic-cli', id: 'c' }), deps);
  await assert.rejects(() => p.invoke('q'), (e) => e.kind === 'provider-error' && /no output/.test(e.message));
});

test('anthropic-cli: a stall (timedOut) fails fast with provider-error', async () => {
  const deps = fakeDeps({ withStdin: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }) });
  const p = createProvider(model({ provider: 'anthropic-cli', id: 'c' }), deps);
  await assert.rejects(() => p.invoke('q'), (e) => e.kind === 'provider-error' && /timed out/.test(e.message));
});

test('anthropic-cli: non-zero exit with partial stdout is rejected (Sol finding 7)', async () => {
  const deps = fakeDeps({ withStdin: () => ({ code: 2, stdout: 'partial', stderr: 'fatal', timedOut: false }) });
  const p = createProvider(model({ provider: 'anthropic-cli', id: 'c' }), deps);
  await assert.rejects(() => p.invoke('q'), (e) => e.kind === 'provider-error' && /exited 2/.test(e.message));
});

test('anthropic-cli: a token_file is injected into the subprocess env (keychain-free), not the parent', async () => {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const tok = credFile('sk-ant-oat-INJECTED\n');
  const deps = fakeDeps();
  const p = createProvider(model({ provider: 'anthropic-cli', id: 'c', tokenFile: tok }), deps);
  await p.invoke('q');
  assert.equal(deps.calls.runWithStdin[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-INJECTED');
  assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'must not touch the parent env');
});

test('anthropic-cli: when the token env var is already set, the file is not injected (child inherits)', async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'ambient';
  try {
    const deps = fakeDeps();
    const p = createProvider(model({ provider: 'anthropic-cli', id: 'c', tokenFile: '/nonexistent' }), deps);
    await p.invoke('q');
    assert.equal(deps.calls.runWithStdin[0].opts.env, undefined);
  } finally {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
});

test('anthropic-cli: a secret in stderr is redacted before it lands in the error message (C3)', async () => {
  const deps = fakeDeps({ withStdin: () => ({ code: 1, stdout: '', stderr: 'auth failed OPENAI_API_KEY=sk-abcdefghij1234567890', timedOut: false }) });
  const p = createProvider(model({ provider: 'anthropic-cli', id: 'c' }), deps);
  await assert.rejects(() => p.invoke('q'), (e) => /\[REDACTED\]/.test(e.message) && !/sk-abcdefghij/.test(e.message));
});

test('openai: reads the key from api_key_file when the env var is unset', async () => {
  delete process.env.ASKUP_TEST_OAI_FILE;
  const keyFile = credFile('sk-from-file-xyz\n');
  const deps = fakeDeps({ http: () => ({ choices: [{ message: { content: 'advice' } }] }) });
  const p = createProvider(model({ provider: 'openai', id: 'gpt', apiKeyEnv: 'ASKUP_TEST_OAI_FILE', apiKeyFile: keyFile, baseUrl: 'https://x' }), deps);
  await p.invoke('q');
  assert.equal(deps.calls.httpPostJson[0].opts.headers.Authorization, 'Bearer sk-from-file-xyz');
});

// ---- codex-cli -------------------------------------------------------------

test('codex-cli: prompt via stdin (-), read-only + skip-git-repo-check, never on argv', async () => {
  const deps = fakeDeps();
  const p = createProvider(model({ provider: 'codex-cli', id: 'gpt-x' }), deps);
  const out = await p.invoke(SENTINEL, { timeoutMs: 1234 });
  assert.equal(out.text, 'advice');
  const call = deps.calls.runWithStdin[0]; // prompt fed on stdin, not argv
  assert.equal(call.cmd, 'codex');
  assert.equal(call.opts.input, SENTINEL);
  assert.ok(!call.args.join(' ').includes(SENTINEL), 'prompt must not be on argv');
  assert.deepEqual(call.args, ['exec', '--skip-git-repo-check', '-s', 'read-only', '-m', 'gpt-x', '-']);
  assert.equal(call.opts.timeoutMs, 1234);
});

test('codex-cli: empty output, stall, and non-zero exit all error', async () => {
  const empty = createProvider(model({ provider: 'codex-cli', id: 'g' }), fakeDeps({ withStdin: () => ({ code: 0, stdout: '', stderr: 'x', timedOut: false }) }));
  await assert.rejects(() => empty.invoke('q'), (e) => e.kind === 'provider-error');
  const stall = createProvider(model({ provider: 'codex-cli', id: 'g' }), fakeDeps({ withStdin: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }) }));
  await assert.rejects(() => stall.invoke('q'), (e) => /timed out/.test(e.message));
  // non-zero exit with partial stdout must NOT be accepted (Sol finding 7)
  const failed = createProvider(model({ provider: 'codex-cli', id: 'g' }), fakeDeps({ withStdin: () => ({ code: 1, stdout: 'partial advice', stderr: 'fatal', timedOut: false }) }));
  await assert.rejects(() => failed.invoke('q'), (e) => e.kind === 'provider-error' && /exited 1/.test(e.message));
});

// ---- ollama ----------------------------------------------------------------

test('ollama: request-shaped (no tools key), returns text + usage', async () => {
  const deps = fakeDeps({ http: () => ({ message: { content: 'advice' }, prompt_eval_count: 12, eval_count: 8 }) });
  const p = createProvider(model({ provider: 'ollama', id: 'glm', baseUrl: 'http://h:1' }), deps);
  const out = await p.invoke('q');
  assert.equal(out.text, 'advice');
  assert.deepEqual(out.usage, { promptTokens: 12, completionTokens: 8 });
  const call = deps.calls.httpPostJson[0];
  assert.equal(call.url, 'http://h:1/api/chat');
  assert.equal(call.body.stream, false);
  assert.ok(!('tools' in call.body), 'ollama request must not include a tools key');
});

test('ollama: empty content errors', async () => {
  const p = createProvider(model({ provider: 'ollama', id: 'g' }), fakeDeps({ http: () => ({ message: { content: '' } }) }));
  await assert.rejects(() => p.invoke('q'), (e) => e.kind === 'provider-error');
});

// ---- openai / openai-compatible -------------------------------------------

test('openai: missing API key errors (chain-fallthrough semantics)', async () => {
  delete process.env.ASKUP_TEST_OPENAI_KEY;
  const p = createProvider(model({ provider: 'openai', id: 'gpt', apiKeyEnv: 'ASKUP_TEST_OPENAI_KEY' }), fakeDeps());
  await assert.rejects(() => p.invoke('q'), (e) => e.kind === 'provider-error' && /not set/.test(e.message));
});

test('openai: with key, request-shaped, Bearer auth, text + usage', async () => {
  process.env.ASKUP_TEST_OPENAI_KEY = 'sk-test';
  try {
    const deps = fakeDeps({ http: () => ({ choices: [{ message: { content: 'advice' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }) });
    const p = createProvider(model({ provider: 'openai', id: 'gpt', apiKeyEnv: 'ASKUP_TEST_OPENAI_KEY', baseUrl: 'https://x' }), deps);
    const out = await p.invoke('q', { system: 'sys' });
    assert.equal(out.text, 'advice');
    assert.deepEqual(out.usage, { promptTokens: 5, completionTokens: 3 });
    const call = deps.calls.httpPostJson[0];
    assert.equal(call.url, 'https://x/v1/chat/completions');
    assert.equal(call.opts.headers.Authorization, 'Bearer sk-test');
    assert.ok(!('tools' in call.body));
    assert.equal(call.body.messages[0].role, 'system');
  } finally {
    delete process.env.ASKUP_TEST_OPENAI_KEY;
  }
});

// ---- anthropic-api ---------------------------------------------------------

test('anthropic-api: request-shaped messages call with x-api-key, text from content blocks', async () => {
  process.env.ASKUP_TEST_ANTHROPIC_KEY = 'sk-ant';
  try {
    const deps = fakeDeps({ http: () => ({ content: [{ text: 'ad' }, { text: 'vice' }], usage: { input_tokens: 9, output_tokens: 4 } }) });
    const p = createProvider(model({ provider: 'anthropic-api', id: 'claude', apiKeyEnv: 'ASKUP_TEST_ANTHROPIC_KEY' }), deps);
    const out = await p.invoke('q');
    assert.equal(out.text, 'advice');
    assert.deepEqual(out.usage, { promptTokens: 9, completionTokens: 4 });
    const call = deps.calls.httpPostJson[0];
    assert.ok(call.url.endsWith('/v1/messages'));
    assert.equal(call.opts.headers['x-api-key'], 'sk-ant');
    assert.ok(!('tools' in call.body));
  } finally {
    delete process.env.ASKUP_TEST_ANTHROPIC_KEY;
  }
});

// ---- registry --------------------------------------------------------------

test('createProvider throws USAGE for an unknown provider', () => {
  assert.throws(() => createProvider(model({ provider: 'nope' })), (e) => e.kind === 'usage');
});
