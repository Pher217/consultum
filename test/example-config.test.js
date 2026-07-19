import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseConfig, resolveAdvisorChain, resolveCurator } from '../src/config.js';

// The "≤15-line config → working setup" acceptance criterion (spec §16).
test('config.example.yaml parses, is <= 15 lines, and resolves a working advisor chain', () => {
  const p = fileURLToPath(new URL('../config.example.yaml', import.meta.url));
  const text = fs.readFileSync(p, 'utf8');

  const nonEmpty = text.split('\n').filter((l) => l.trim().length > 0);
  assert.ok(nonEmpty.length <= 15, `example config should be <= 15 non-empty lines, got ${nonEmpty.length}`);

  const cfg = parseConfig(text, 'config.example.yaml');
  const chain = resolveAdvisorChain(cfg, { sensitive: false });
  assert.ok(chain.length >= 1, 'a normal request must resolve at least one advisor');
  // sensitive must still resolve a trusted/local advisor (fail-closed usability)
  const sChain = resolveAdvisorChain(cfg, { sensitive: true });
  assert.ok(sChain.length >= 1, 'a sensitive request must resolve a trusted/local advisor');
  // curator omitted in the example -> deterministic template
  assert.equal(resolveCurator(cfg, { sensitive: false }), null);
});
