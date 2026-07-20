import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseConfig,
  loadConfig,
  discoverConfigPath,
  applyEnvOverrides,
  resolveAdvisorChain,
  resolveCurator,
  isSensitive,
} from '../src/config.js';

const VALID = `
models:
  strong:  { provider: anthropic-cli, id: claude-strong-4-8, trust: trusted }
  gpt:   { provider: codex-cli,     id: gpt-5.6-gpt,     trust: untrusted }
  curatorm:   { provider: ollama,        id: curatorm-5.2:cloud,   trust: untrusted }
  local: { provider: ollama,        id: gemma3:27b,      trust: local }
roles:
  advisor: [strong, gpt]
  curator: curatorm
policy:
  default_sensitive: false
`;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'askup-cfg-'));
}

test('parseConfig normalizes models, roles, and applies policy defaults', () => {
  const c = parseConfig(VALID, 'test.yaml');
  assert.equal(c.models.strong.provider, 'anthropic-cli');
  assert.equal(c.models.strong.trust, 'trusted');
  assert.deepEqual(c.roles.advisor, ['strong', 'gpt']);
  assert.equal(c.roles.curator, 'curatorm');
  // defaults
  assert.equal(c.policy.max_consults_per_task, 3);
  assert.equal(c.policy.panel_threshold, 70);
  assert.equal(c.policy.curate, false);
});

test('parseConfig reads token_file/token_env/api_key_file onto the model entry', () => {
  const c = parseConfig(`
models:
  strong: { provider: anthropic-cli, id: x, trust: trusted, token_file: ./tok, token_env: CLAUDE_CODE_OAUTH_TOKEN }
  gpt:  { provider: openai, id: y, trust: untrusted, api_key_env: OPENAI_API_KEY, api_key_file: ./key }
roles:
  advisor: [strong, gpt]
`);
  assert.equal(c.models.strong.tokenFile, './tok');
  assert.equal(c.models.strong.tokenEnv, 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.equal(c.models.gpt.apiKeyFile, './key');
});

test('parseConfig rejects unknown provider', () => {
  const bad = `models:\n  x: { provider: magic, id: y, trust: trusted }\nroles:\n  advisor: x\n`;
  assert.throws(() => parseConfig(bad), /unknown provider/);
});

test('parseConfig rejects missing id and bad trust', () => {
  assert.throws(() => parseConfig(`models:\n  x: { provider: ollama, trust: local }\nroles:\n  advisor: x\n`), /non-empty 'id'/);
  assert.throws(() => parseConfig(`models:\n  x: { provider: ollama, id: y, trust: banana }\nroles:\n  advisor: x\n`), /trust one of/);
});

test('parseConfig rejects advisor referencing unknown model', () => {
  assert.throws(() => parseConfig(`models:\n  x: { provider: ollama, id: y, trust: local }\nroles:\n  advisor: nope\n`), /unknown model/);
});

test('parseConfig requires an advisor role', () => {
  assert.throws(() => parseConfig(`models:\n  x: { provider: ollama, id: y, trust: local }\nroles: {}\n`), /roles.advisor/);
});

test('tools without a dirs scope are refused (opt-in AND directory-scoped)', () => {
  const cfg = `models:\n  o: { provider: anthropic-cli, id: x, trust: trusted, tools: { allow: [Read] } }\nroles:\n  advisor: o\n`;
  assert.throws(() => parseConfig(cfg), /directory scope is required/);
});

test('tools with allow + dirs are accepted', () => {
  const cfg = `models:\n  o: { provider: anthropic-cli, id: x, trust: trusted, tools: { allow: [Read], dirs: [./ctx] } }\nroles:\n  advisor: o\n`;
  const c = parseConfig(cfg);
  assert.deepEqual(c.models.o.tools, { allow: ['Read'], dirs: ['./ctx'] });
});

test('tools reject shell/network names (only read-only fs tools may be granted)', () => {
  for (const bad of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) {
    const cfg = `models:\n  o: { provider: anthropic-cli, id: x, trust: trusted, tools: { allow: [${bad}], dirs: [./ctx] } }\nroles:\n  advisor: o\n`;
    assert.throws(() => parseConfig(cfg), (e) => e.kind === 'usage' && /not permitted/.test(e.message), `expected ${bad} to be rejected`);
  }
});

test('policy: a mistyped default_sensitive (string) is a config error, not a silent fail-open', () => {
  // Regression: "true" (string) must NOT be accepted and resolve as non-sensitive.
  assert.throws(
    () => parseConfig(`models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\nroles:\n  advisor: o\npolicy:\n  default_sensitive: "true"\n`),
    (e) => e.kind === 'usage' && /default_sensitive must be a boolean/.test(e.message),
  );
});

test('policy: numeric fields are range-validated', () => {
  const base = 'models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\nroles:\n  advisor: o\npolicy:\n';
  assert.throws(() => parseConfig(base + '  panel_threshold: 200\n'), /panel_threshold must be in/);
  assert.throws(() => parseConfig(base + '  max_consults_per_task: 0\n'), /max_consults_per_task must be in/);
  assert.throws(() => parseConfig(base + '  panel_threshold: "70"\n'), /panel_threshold must be an integer/);
});

test('sensitive_paths glob matches at the root and across segments, and normalizes backslashes', () => {
  const c = parseConfig(`models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\nroles:\n  advisor: o\npolicy:\n  sensitive_paths: ["**/secrets/**"]\n`);
  assert.equal(isSensitive(c, { sourcePath: 'secrets/db.txt' }), true); // root
  assert.equal(isSensitive(c, { sourcePath: 'a/b/secrets/db.txt' }), true); // nested
  assert.equal(isSensitive(c, { sourcePath: 'app\\secrets\\db.txt' }), true); // windows separators
  assert.equal(isSensitive(c, { sourcePath: 'app/main.js' }), false);
});

test('discoverConfigPath honors ASKUP_CONFIG over cwd', () => {
  const dir = tmpdir();
  const explicit = path.join(dir, 'custom.yaml');
  fs.writeFileSync(explicit, VALID);
  fs.writeFileSync(path.join(dir, 'askup.yaml'), VALID);
  const found = discoverConfigPath({ cwd: dir, env: { ASKUP_CONFIG: explicit }, home: dir });
  assert.equal(found, explicit);
});

test('discoverConfigPath finds ./askup.yaml when no env override', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'askup.yaml');
  fs.writeFileSync(p, VALID);
  const found = discoverConfigPath({ cwd: dir, env: {}, home: path.join(dir, 'nohome') });
  assert.equal(found, p);
});

test('loadConfig throws USAGE when no config exists', () => {
  const dir = tmpdir();
  assert.throws(
    () => loadConfig({ cwd: dir, env: {}, home: path.join(dir, 'nohome') }),
    (e) => e.kind === 'usage' && /no askup config/.test(e.message),
  );
});

test('applyEnvOverrides overrides id and base_url by model name', () => {
  const c = parseConfig(VALID);
  applyEnvOverrides(c, { ASKUP_MODEL_STRONG_ID: 'claude-strong-9', ASKUP_MODEL_LOCAL_BASE_URL: 'http://x:1' });
  assert.equal(c.models.strong.id, 'claude-strong-9');
  assert.equal(c.models.local.baseUrl, 'http://x:1');
});

test('resolveAdvisorChain preserves order when not sensitive', () => {
  const c = parseConfig(VALID);
  const chain = resolveAdvisorChain(c, { sensitive: false });
  assert.deepEqual(chain.map((m) => m.name), ['strong', 'gpt']);
});

test('resolveAdvisorChain drops untrusted advisors when sensitive', () => {
  const c = parseConfig(VALID);
  const chain = resolveAdvisorChain(c, { sensitive: true });
  // gpt is untrusted -> filtered; strong (trusted) survives
  assert.deepEqual(chain.map((m) => m.name), ['strong']);
});

test('resolveAdvisorChain can return [] when a sensitive request has only untrusted advisors', () => {
  const c = parseConfig(`models:\n  gpt: { provider: codex-cli, id: g, trust: untrusted }\nroles:\n  advisor: [gpt]\n`);
  assert.deepEqual(resolveAdvisorChain(c, { sensitive: true }), []);
});

test('resolveCurator: omitted -> null; untrusted+sensitive -> null; trusted+sensitive -> entry', () => {
  const noCur = parseConfig(`models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\nroles:\n  advisor: o\n`);
  assert.equal(resolveCurator(noCur, { sensitive: false }), null);

  const c = parseConfig(VALID); // curator curatorm is untrusted
  assert.equal(resolveCurator(c, { sensitive: false }).name, 'curatorm');
  assert.equal(resolveCurator(c, { sensitive: true }), null); // fail-closed skip

  const trustedCur = parseConfig(`models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\n  cur: { provider: ollama, id: y, trust: local }\nroles:\n  advisor: o\n  curator: cur\n`);
  assert.equal(resolveCurator(trustedCur, { sensitive: true }).name, 'cur');
});

test('isSensitive: default_sensitive forces true; flag only escalates', () => {
  const off = parseConfig(VALID);
  assert.equal(isSensitive(off, { flagSensitive: false }), false);
  assert.equal(isSensitive(off, { flagSensitive: true }), true);

  const on = parseConfig(VALID.replace('default_sensitive: false', 'default_sensitive: true'));
  // flag false cannot de-escalate a config-sensitive default
  assert.equal(isSensitive(on, { flagSensitive: false }), true);
});

test('isSensitive: a sourcePath matching sensitive_paths forces sensitive', () => {
  const c = parseConfig(`models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\nroles:\n  advisor: o\npolicy:\n  sensitive_paths: ["**/secrets/**", "*.pem"]\n`);
  assert.equal(isSensitive(c, { sourcePath: 'app/secrets/db.txt' }), true);
  assert.equal(isSensitive(c, { sourcePath: 'key.pem' }), true);
  assert.equal(isSensitive(c, { sourcePath: 'app/main.js' }), false);
});
