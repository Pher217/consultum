import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { askupTool, TOOL_SCHEMA } from '../src/shim.js';
import { parseConfig } from '../src/config.js';

test('shim/tool-schema.json stays in sync with the exported TOOL_SCHEMA', () => {
  const p = fileURLToPath(new URL('../shim/tool-schema.json', import.meta.url));
  const onDisk = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.deepEqual(onDisk, TOOL_SCHEMA);
});

const REC = '## Recommended Approach\nDo the safe thing.\n## Confidence\n88';
const CFG = parseConfig('models:\n  adv: { provider: ollama, id: adv-model, trust: trusted }\nroles:\n  advisor: [adv]\n');
const okDeps = { httpPostJson: async () => ({ message: { content: REC } }) };

test('TOOL_SCHEMA is a valid function schema requiring question + packet', () => {
  assert.equal(TOOL_SCHEMA.function.name, 'consult_advisor');
  assert.deepEqual(TOOL_SCHEMA.function.parameters.required, ['question', 'packet']);
});

test('askupTool returns { ok: true, ...rec } on success (packet maps to context)', async () => {
  const res = await askupTool({ question: 'q', packet: 'objective ...' }, { config: CFG, deps: okDeps });
  assert.equal(res.ok, true);
  assert.equal(res.recommendation, 'Do the safe thing.');
  assert.equal(res.provenance.advisorModel, 'adv-model');
});

test('askupTool never throws — a policy refusal comes back as { ok: false, error }', async () => {
  const cfg = parseConfig('models:\n  sol: { provider: codex-cli, id: s, trust: untrusted }\nroles:\n  advisor: [sol]\n');
  const res = await askupTool({ question: 'q', packet: 'p', sensitive: true }, { config: cfg, deps: okDeps });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, 'refused-by-policy');
});

test('askupTool surfaces a provider error as { ok: false, error }', async () => {
  const badDeps = { httpPostJson: async () => { throw new Error('down'); } };
  const res = await askupTool({ question: 'q', packet: 'p' }, { config: CFG, deps: badDeps });
  assert.equal(res.ok, false);
  assert.equal(res.error.kind, 'provider-error');
});
