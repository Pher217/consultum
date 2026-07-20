import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consult } from '../src/consult.js';
import { parseConfig, resolvePanel, resolveReconciler } from '../src/config.js';
import { convenePanel, correlationWarning, buildReconcilerPrompt } from '../src/panel.js';
import { parseRecommendation } from '../src/recommendation.js';

const REC = (approach, conf) =>
  `## Recommended Approach\n${approach}\n## Risks\nsome risk\n## Confidence\n${conf}`;

const CFG = `
models:
  adv:   { provider: ollama, id: adv-model,  trust: trusted }
  p1:    { provider: ollama, id: panel-one,  trust: trusted }
  p2:    { provider: openai, id: panel-two,  trust: trusted, api_key_env: ASKUP_TEST_PANEL_KEY }
  recon: { provider: ollama, id: recon-model, trust: trusted }
roles:
  advisor: [adv]
  panel: [p1, p2]
  reconciler: recon
`;

// deps that answer differently per model id, so panelist views are distinguishable
function deps(byModel, calls = []) {
  return {
    runNoStdin: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    runWithStdin: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    httpPostJson: async (url, body) => {
      calls.push(body.model);
      const text = byModel[body.model];
      if (text instanceof Error) throw text;
      if (url.includes('/v1/chat/completions')) return { choices: [{ message: { content: text } }] };
      return { message: { content: text } };
    },
  };
}

test('config: panel + reconciler resolve, and are trust-filtered when sensitive', () => {
  const c = parseConfig(CFG);
  assert.deepEqual(resolvePanel(c, { sensitive: false }).map((m) => m.name), ['p1', 'p2']);
  assert.equal(resolveReconciler(c, { sensitive: false }).name, 'recon');

  const mixed = parseConfig(`
models:
  a:  { provider: ollama, id: a, trust: trusted }
  u:  { provider: codex-cli, id: u, trust: untrusted }
  t:  { provider: ollama, id: t, trust: trusted }
roles:
  advisor: [a]
  panel: [u, t]
  reconciler: u
`);
  // untrusted panelist and reconciler are dropped on a sensitive request (fail-closed)
  assert.deepEqual(resolvePanel(mixed, { sensitive: true }).map((m) => m.name), ['t']);
  assert.equal(resolveReconciler(mixed, { sensitive: true }), null);
});

test('config rejects unknown panel / reconciler models', () => {
  assert.throws(() => parseConfig('models:\n  a: { provider: ollama, id: a, trust: local }\nroles:\n  advisor: [a]\n  panel: [nope]\n'), /roles.panel references unknown model/);
  assert.throws(() => parseConfig('models:\n  a: { provider: ollama, id: a, trust: local }\nroles:\n  advisor: [a]\n  reconciler: nope\n'), /roles.reconciler references unknown model/);
});

test('--panel convenes the panel and every view is visible', async () => {
  process.env.ASKUP_TEST_PANEL_KEY = 'k';
  try {
    const d = deps({
      'adv-model': REC('primary approach', 90),
      'panel-one': REC('panelist one approach', 80),
      'panel-two': REC('panelist two approach', 60),
      'recon-model': REC('reconciled approach', 75),
    });
    const rec = await consult({ question: 'q', context: 'c', panel: true, config: parseConfig(CFG), deps: d });
    assert.equal(rec.panel.convened, true);
    assert.equal(rec.panel.trigger, 'requested');
    assert.equal(rec.panel.views.length, 2);
    assert.deepEqual(rec.panel.views.map((v) => v.model).sort(), ['panel-one', 'panel-two']);
    // primary recommendation is untouched by the panel
    assert.match(rec.recommendation, /primary approach/);
  } finally {
    delete process.env.ASKUP_TEST_PANEL_KEY;
  }
});

test('low confidence auto-triggers the panel; high confidence does not', async () => {
  process.env.ASKUP_TEST_PANEL_KEY = 'k';
  try {
    const low = await consult({
      question: 'q', config: parseConfig(CFG),
      deps: deps({ 'adv-model': REC('unsure', 20), 'panel-one': REC('one', 80), 'panel-two': REC('two', 70), 'recon-model': REC('r', 75) }),
    });
    assert.equal(low.panel.trigger, 'low-confidence');

    const high = await consult({
      question: 'q', config: parseConfig(CFG),
      deps: deps({ 'adv-model': REC('confident', 95), 'panel-one': REC('one', 80), 'panel-two': REC('two', 70), 'recon-model': REC('r', 75) }),
    });
    assert.equal(high.panel, null, 'a confident answer should not spend tokens on a panel');
  } finally {
    delete process.env.ASKUP_TEST_PANEL_KEY;
  }
});

test('WITHOUT a reconciler askup does NOT claim agreement — it reports "unassessed"', async () => {
  // Regression for spec §18: free-text agreement detection is not deterministic, so never fake it.
  const noRecon = parseConfig(`
models:
  adv: { provider: ollama, id: adv-model, trust: trusted }
  p1:  { provider: ollama, id: panel-one, trust: trusted }
roles:
  advisor: [adv]
  panel: [p1]
`);
  const rec = await consult({
    question: 'q', panel: true, config: noRecon,
    deps: deps({ 'adv-model': REC('primary', 50), 'panel-one': REC('a flatly contradictory view', 80) }),
  });
  assert.equal(rec.panel.agreement, 'unassessed');
  assert.equal(rec.panel.reconciliation, null);
  assert.equal(rec.panel.reconciledBy, null);
  assert.equal(rec.panel.views.length, 1);
});

test('a reconciler synthesizes and is labelled as such', async () => {
  process.env.ASKUP_TEST_PANEL_KEY = 'k';
  try {
    const rec = await consult({
      question: 'q', panel: true, config: parseConfig(CFG),
      deps: deps({ 'adv-model': REC('primary', 50), 'panel-one': REC('one', 80), 'panel-two': REC('two', 70), 'recon-model': REC('the reconciled view', 75) }),
    });
    assert.equal(rec.panel.agreement, 'reconciled');
    assert.match(rec.panel.reconciliation, /the reconciled view/);
    assert.equal(rec.panel.reconciledBy, 'recon-model');
  } finally {
    delete process.env.ASKUP_TEST_PANEL_KEY;
  }
});

test('a failing panelist is recorded but does not sink the panel', async () => {
  process.env.ASKUP_TEST_PANEL_KEY = 'k';
  try {
    const rec = await consult({
      question: 'q', panel: true, config: parseConfig(CFG),
      deps: deps({ 'adv-model': REC('primary', 50), 'panel-one': REC('one', 80), 'panel-two': new Error('provider down'), 'recon-model': REC('r', 75) }),
    });
    assert.equal(rec.panel.views.length, 1);
    assert.equal(rec.panel.failures.length, 1);
    assert.match(rec.panel.failures[0], /p2/);
  } finally {
    delete process.env.ASKUP_TEST_PANEL_KEY;
  }
});

test('a panelist sharing an id with the advisor but on ANOTHER provider is kept (live-caught bug)', async () => {
  // Regression: dedupe must be by (provider, id), not id alone — otherwise a legitimately distinct
  // panelist vanishes silently (not in views, not in failures).
  const cfg = parseConfig(`
models:
  adv: { provider: ollama, id: same-id, trust: trusted }
  p:   { provider: openai-compatible, id: same-id, trust: trusted, base_url: http://x, api_key_env: ASKUP_TEST_PANEL_KEY }
roles:
  advisor: [adv]
  panel: [p]
`);
  process.env.ASKUP_TEST_PANEL_KEY = 'k';
  try {
    const rec = await consult({
      question: 'q', panel: true, config: cfg,
      deps: deps({ 'same-id': REC('an answer', 50) }),
    });
    assert.equal(rec.panel.views.length, 1, 'different-provider panelist must not be filtered out');
    assert.equal(rec.panel.views[0].provider, 'openai-compatible');
  } finally {
    delete process.env.ASKUP_TEST_PANEL_KEY;
  }
});

test('the SAME model entry as the advisor is excluded (no fake independence)', async () => {
  const cfg = parseConfig(`
models:
  adv: { provider: ollama, id: dup, trust: trusted }
  p:   { provider: ollama, id: dup, trust: trusted }
roles:
  advisor: [adv]
  panel: [p]
`);
  const rec = await consult({
    question: 'q', panel: true, config: cfg,
    deps: deps({ dup: REC('an answer', 50) }),
  });
  assert.equal(rec.panel, null, 'same provider+id adds no independence -> no panel convened');
});

test('a FAILED reconciler is reported distinctly, not disguised as "none configured" (live-caught)', async () => {
  const cfg = parseConfig(`
models:
  adv:   { provider: ollama, id: adv-model, trust: trusted }
  p1:    { provider: ollama, id: panel-one, trust: trusted }
  recon: { provider: ollama, id: recon-model, trust: trusted }
roles:
  advisor: [adv]
  panel: [p1]
  reconciler: recon
`);
  const rec = await consult({
    question: 'q', panel: true, config: cfg,
    // reconciler returns unparseable output on BOTH attempts -> failed, not silently absent
    deps: deps({ 'adv-model': REC('primary', 50), 'panel-one': REC('one', 80), 'recon-model': 'garbage with no sections' }),
  });
  assert.equal(rec.panel.agreement, 'reconciler-failed');
  assert.equal(rec.panel.reconciliation, null);
  assert.match(rec.panel.reconcilerError, /recon-model/);
});

test('a single-provider panel is flagged as correlated', () => {
  assert.match(
    correlationWarning([{ provider: 'ollama' }, { provider: 'ollama' }]),
    /correlated/,
  );
  assert.equal(correlationWarning([{ provider: 'ollama' }, { provider: 'openai' }]), null);
});

test('panelists run concurrently, not serially', async () => {
  const order = [];
  const slow = (ms, text) => async () => { await new Promise((r) => setTimeout(r, ms)); order.push(text); return text; };
  const panelists = [
    { name: 'a', id: 'a', provider: 'ollama', trust: 'trusted', baseUrl: null, apiKeyEnv: null, timeoutMs: null, tools: null },
    { name: 'b', id: 'b', provider: 'ollama', trust: 'trusted', baseUrl: null, apiKeyEnv: null, timeoutMs: null, tools: null },
  ];
  const d = {
    httpPostJson: async (u, body) => {
      // 'a' is slow, 'b' is fast — concurrent execution finishes b first
      const t = body.model === 'a' ? await slow(40, 'a')() : await slow(5, 'b')();
      return { message: { content: REC(t, 80) } };
    },
  };
  const { views } = await convenePanel(panelists, { prompt: 'p', system: 's', timeoutMs: 5000, deps: d, parse: (t) => parseRecommendation(t) });
  assert.equal(views.length, 2);
  assert.deepEqual(order, ['b', 'a'], 'fast panelist should finish first => they ran in parallel');
});

test('reconciler prompt wraps views as untrusted data', () => {
  const p = buildReconcilerPrompt('the question', [{ model: 'm1', confidence: 80, recommendation: 'do X', risks: null }]);
  assert.match(p, /UNTRUSTED DATA/);
  assert.match(p, /do X/);
});
