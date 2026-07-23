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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'consultum-cfg-'));
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

test('sensitive_paths matching is case-insensitive (Windows fail-open guard)', () => {
  // GIVEN a `**/secrets/**` rule, WHEN a Windows-style path uses a different case (App\Secrets\db.txt),
  // THEN it still matches — a case-sensitive match would miss it and route sensitive data to an
  // untrusted advisor (a fail-open). Matching case-insensitively fails CLOSED.
  const c = parseConfig(`models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\nroles:\n  advisor: o\npolicy:\n  sensitive_paths: ["**/secrets/**"]\n`);
  assert.equal(isSensitive(c, { sourcePath: 'App\\Secrets\\db.txt' }), true);
  assert.equal(isSensitive(c, { sourcePath: 'PROJECT/SECRETS/KEY.PEM' }), true);
});

test('parseConfig rejects an Object.prototype key as a role model name (no crash, clean usage error)', () => {
  // GIVEN roles.advisor: toString, WHEN parsed, THEN it is an unknown-model usage error — NOT accepted
  // via Object.prototype (which then crashes when the "model" is resolved to a function).
  const bad = `models:\n  x: { provider: ollama, id: y, trust: local }\nroles:\n  advisor: toString\n`;
  assert.throws(() => parseConfig(bad, 'test.yaml'), (e) => e.kind === 'usage' && /unknown model 'toString'/.test(e.message));
});

test('parseConfig rejects a non-string base_url and a non-integer timeout_ms at parse time', () => {
  // GIVEN base_url: 42, WHEN parsed, THEN a clean usage error — not a silent accept that later throws
  // an uncaught TypeError (exit 1, outside the contract).
  const badUrl = `models:\n  x: { provider: openai, id: y, trust: untrusted, base_url: 42 }\nroles:\n  advisor: x\n`;
  assert.throws(() => parseConfig(badUrl, 'test.yaml'), (e) => e.kind === 'usage' && /base_url must be a string/.test(e.message));
  const badTimeout = `models:\n  x: { provider: openai, id: y, trust: untrusted, timeout_ms: "soon" }\nroles:\n  advisor: x\n`;
  assert.throws(() => parseConfig(badTimeout, 'test.yaml'), (e) => e.kind === 'usage' && /timeout_ms must be a positive integer/.test(e.message));
});

test('discoverConfigPath honors CONSULTUM_CONFIG over cwd', () => {
  const dir = tmpdir();
  const explicit = path.join(dir, 'custom.yaml');
  fs.writeFileSync(explicit, VALID);
  fs.writeFileSync(path.join(dir, 'consultum.yaml'), VALID);
  const found = discoverConfigPath({ cwd: dir, env: { CONSULTUM_CONFIG: explicit }, home: dir });
  assert.equal(found, explicit);
});

test('discoverConfigPath finds ./consultum.yaml when no env override', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'consultum.yaml');
  fs.writeFileSync(p, VALID);
  const found = discoverConfigPath({ cwd: dir, env: {}, home: path.join(dir, 'nohome') });
  assert.equal(found, p);
});

test('loadConfig throws USAGE when no config exists', () => {
  const dir = tmpdir();
  assert.throws(
    () => loadConfig({ cwd: dir, env: {}, home: path.join(dir, 'nohome') }),
    (e) => e.kind === 'usage' && /no consultum config/.test(e.message),
  );
});

test('applyEnvOverrides overrides id and base_url by model name', () => {
  const c = parseConfig(VALID);
  applyEnvOverrides(c, { CONSULTUM_MODEL_STRONG_ID: 'claude-strong-9', CONSULTUM_MODEL_LOCAL_BASE_URL: 'http://x:1' });
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

test('parseConfig rejects an unknown top-level key', () => {
  // GIVEN a config with a stray top-level key
  // WHEN parsed
  // THEN it errors with KIND.USAGE (exit 10) and names the offending key
  const bad = `models:\n  x: { provider: ollama, id: y, trust: local }\nroles:\n  advisor: x\npolciy:\n  default_sensitive: true\n`;
  assert.throws(
    () => parseConfig(bad, 'test.yaml'),
    (e) => e.kind === 'usage' && e.exitCode === 10 && /unknown top-level key 'polciy'/.test(e.message),
  );
});

test("parseConfig rejects a typo'd policy key ('defualt_sensitive') instead of silently defaulting default_sensitive to false", () => {
  // GIVEN a config with `defualt_sensitive: true` (typo of `default_sensitive`)
  // WHEN parsed
  // THEN it must hard-error, NOT silently ignore the typo and leave default_sensitive at its false
  //      default (which would be a fail-open: the user believes every request is sensitive, but
  //      isSensitive() would return false and requests could reach untrusted third-party providers).
  const bad = `models:\n  x: { provider: ollama, id: y, trust: local }\nroles:\n  advisor: x\npolicy:\n  defualt_sensitive: true\n`;
  assert.throws(
    () => parseConfig(bad, 'test.yaml'),
    (e) => e.kind === 'usage' && e.exitCode === 10 && /unknown policy key 'defualt_sensitive'/.test(e.message) && /default_sensitive/.test(e.message),
  );
});

test('parseConfig rejects an Object.prototype key as a policy key (no prototype-chain bypass or crash)', () => {
  // GIVEN a policy with keys that live on Object.prototype (toString, constructor, valueOf), WHEN
  // parsed, THEN each is a clean unknown-policy-key usage error — NOT accepted as "known" via the
  // prototype chain (which then crashed validatePolicyValue with an uncaught TypeError). Found by an
  // independent review probing `policy: { toString: 1 }`.
  for (const proto of ['toString', 'constructor', 'valueOf', 'hasOwnProperty']) {
    const bad = `models:\n  x: { provider: ollama, id: y, trust: local }\nroles:\n  advisor: x\npolicy:\n  ${proto}: 1\n`;
    assert.throws(
      () => parseConfig(bad, 'test.yaml'),
      (e) => e.kind === 'usage' && e.exitCode === 10 && new RegExp(`unknown policy key '${proto}'`).test(e.message),
      `policy key '${proto}' must be a clean usage error`,
    );
  }
});

test('parseConfig rejects an unknown roles key', () => {
  // GIVEN a config with a stray roles key
  // WHEN parsed
  // THEN it errors and names the offending key
  const bad = `models:\n  x: { provider: ollama, id: y, trust: local }\nroles:\n  advisor: x\n  advizor: x\n`;
  assert.throws(
    () => parseConfig(bad, 'test.yaml'),
    (e) => e.kind === 'usage' && e.exitCode === 10 && /unknown roles key 'advizor'/.test(e.message),
  );
});

test('parseConfig rejects an unknown model-spec key', () => {
  // GIVEN a model spec with a typo'd key ('api_key_ev' instead of 'api_key_env')
  // WHEN parsed
  // THEN it errors and names the offending key
  const bad = `models:\n  x: { provider: openai, id: y, trust: untrusted, api_key_ev: OPENAI_API_KEY }\nroles:\n  advisor: x\n`;
  assert.throws(
    () => parseConfig(bad, 'test.yaml'),
    (e) => e.kind === 'usage' && e.exitCode === 10 && /model 'x' has unknown key 'api_key_ev'/.test(e.message),
  );
});

test('parseConfig rejects an unknown key inside a model tools mapping', () => {
  // GIVEN a model's `tools` mapping with a stray key
  // WHEN parsed
  // THEN it errors and names the offending key
  const bad = `models:\n  o: { provider: anthropic-cli, id: x, trust: trusted, tools: { allow: [Read], dirs: [./ctx], allwo: [Read] } }\nroles:\n  advisor: o\n`;
  assert.throws(
    () => parseConfig(bad, 'test.yaml'),
    (e) => e.kind === 'usage' && e.exitCode === 10 && /tools has unknown key 'allwo'/.test(e.message),
  );
});

test('parseConfig accepts a config using every known key in both snake_case and camelCase spellings (regression guard against over-rejection)', () => {
  // GIVEN a config exercising every known top-level, roles, policy, and model-spec key, once in
  // snake_case and once in camelCase for the model-spec aliases
  // WHEN parsed
  // THEN it parses without error and all fields land correctly
  const cfg = `
models:
  snake: { provider: anthropic-cli, id: m1, trust: trusted, base_url: http://a, api_key_env: A_ENV, api_key_file: ./a-key, token_env: A_TOK, token_file: ./a-tok, timeout_ms: 1000, tools: { allow: [Read], dirs: [./ctx] } }
  camel: { provider: openai, id: m2, trust: untrusted, baseUrl: http://b, apiKeyEnv: B_ENV, apiKeyFile: ./b-key, tokenEnv: B_TOK, tokenFile: ./b-tok, timeoutMs: 2000 }
roles:
  advisor: [snake, camel]
  curator: snake
  panel: [snake, camel]
  reconciler: snake
policy:
  default_sensitive: false
  curate: true
  panel_threshold: 50
  panel_auto: false
  max_consults_per_task: 2
  min_attempts_before_debug_consult: 1
  sensitive_paths: ["**/secrets/**"]
`;
  const c = parseConfig(cfg, 'test.yaml');
  assert.equal(c.models.snake.baseUrl, 'http://a');
  assert.equal(c.models.snake.apiKeyEnv, 'A_ENV');
  assert.equal(c.models.snake.apiKeyFile, './a-key');
  assert.equal(c.models.snake.tokenEnv, 'A_TOK');
  assert.equal(c.models.snake.tokenFile, './a-tok');
  assert.equal(c.models.snake.timeoutMs, 1000);
  assert.deepEqual(c.models.snake.tools, { allow: ['Read'], dirs: ['./ctx'] });
  assert.equal(c.models.camel.baseUrl, 'http://b');
  assert.equal(c.models.camel.apiKeyEnv, 'B_ENV');
  assert.equal(c.models.camel.apiKeyFile, './b-key');
  assert.equal(c.models.camel.tokenEnv, 'B_TOK');
  assert.equal(c.models.camel.tokenFile, './b-tok');
  assert.equal(c.models.camel.timeoutMs, 2000);
  assert.equal(c.roles.curator, 'snake');
  assert.deepEqual(c.roles.panel, ['snake', 'camel']);
  assert.equal(c.roles.reconciler, 'snake');
  assert.equal(c.policy.curate, true);
  assert.equal(c.policy.panel_threshold, 50);
});

test('isSensitive: a sourcePath matching sensitive_paths forces sensitive', () => {
  const c = parseConfig(`models:\n  o: { provider: anthropic-cli, id: x, trust: trusted }\nroles:\n  advisor: o\npolicy:\n  sensitive_paths: ["**/secrets/**", "*.pem"]\n`);
  assert.equal(isSensitive(c, { sourcePath: 'app/secrets/db.txt' }), true);
  assert.equal(isSensitive(c, { sourcePath: 'key.pem' }), true);
  assert.equal(isSensitive(c, { sourcePath: 'app/main.js' }), false);
});
