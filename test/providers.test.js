import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider } from '../src/providers/index.js';

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

// ---- codex-cli -------------------------------------------------------------

test('codex-cli: uses read-only + skip-git-repo-check + /dev/null stdin, no tools', async () => {
  const deps = fakeDeps();
  const p = createProvider(model({ provider: 'codex-cli', id: 'gpt-x' }), deps);
  const out = await p.invoke('q', { timeoutMs: 1234 });
  assert.equal(out.text, 'advice');
  const call = deps.calls.runNoStdin[0]; // /dev/null-stdin path
  assert.equal(call.cmd, 'codex');
  assert.ok(call.args.includes('--skip-git-repo-check'));
  assert.deepEqual(call.args.slice(0, 5), ['exec', '--skip-git-repo-check', '-s', 'read-only', '-m']);
  assert.equal(call.opts.timeoutMs, 1234);
});

test('codex-cli: empty output and stall both error', async () => {
  const empty = createProvider(model({ provider: 'codex-cli', id: 'g' }), fakeDeps({ noStdin: () => ({ code: 0, stdout: '', stderr: 'x', timedOut: false }) }));
  await assert.rejects(() => empty.invoke('q'), (e) => e.kind === 'provider-error');
  const stall = createProvider(model({ provider: 'codex-cli', id: 'g' }), fakeDeps({ noStdin: () => ({ code: -1, stdout: '', stderr: '', timedOut: true }) }));
  await assert.rejects(() => stall.invoke('q'), (e) => /timed out/.test(e.message));
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
