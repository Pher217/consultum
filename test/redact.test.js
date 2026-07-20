import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/redact.js';

// The 10-case redaction regression (spec §16 acceptance criterion). Ported from the hardened
// production implementation. If any of these regress, secrets can cross a model boundary.

test('1. AWS secret access key assignment is redacted', () => {
  const out = redactSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  assert.equal(out, 'AWS_SECRET_ACCESS_KEY=[REDACTED]');
});

test('2. GitHub token assignment is redacted', () => {
  const out = redactSecrets('GITHUB_TOKEN=ghp_1234567890abcdefghijklmnop');
  assert.equal(out, 'GITHUB_TOKEN=[REDACTED]');
});

test('3. OpenAI API key assignment is redacted', () => {
  const out = redactSecrets('OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl');
  assert.equal(out, 'OPENAI_API_KEY=[REDACTED]');
});

test('4. bare GitHub PAT in prose is redacted by shape', () => {
  const out = redactSecrets('the runner logged ghp_abcdefghij1234567890XYZ before it failed');
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /ghp_abcdefghij/);
});

test('5. bare AWS access key id in prose is redacted by shape', () => {
  const out = redactSecrets('key id AKIAIOSFODNN7EXAMPLE appeared in the trace');
  assert.match(out, /\[REDACTED\]/);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
});

test('6. PEM private key block is redacted whole', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Zx\nabc123\n-----END RSA PRIVATE KEY-----';
  const out = redactSecrets(`here is the key:\n${pem}\nend`);
  assert.match(out, /\[REDACTED PRIVATE KEY\]/);
  assert.doesNotMatch(out, /MIIEpAIBAAKCAQEA/);
});

test('7. JWT is redacted by shape', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
  const out = redactSecrets(`token was ${jwt} in the header`);
  assert.match(out, /\[REDACTED JWT\]/);
  assert.doesNotMatch(out, /eyJhbGci/);
});

test('8. scheme://user:pass@host DSN is redacted', () => {
  const out = redactSecrets('connecting to postgres://admin:s3cr3tP4ss@db.internal:5432/app now');
  assert.match(out, /\[REDACTED DSN\]/);
  assert.doesNotMatch(out, /s3cr3tP4ss/);
});

test('9. standalone Bearer token (no key name) is redacted', () => {
  const out = redactSecrets('sent header value "Bearer aGVsbG8xMjM0NTY3ODkw"');
  assert.match(out, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(out, /aGVsbG8xMjM0/);
});

test('10. false-positive guard: non-secret assignments and prose are left alone', () => {
  const benign = 'username = alice\nretries = 42\n# put your PASSWORD in the settings UI\nlet total = subtotal + tax';
  assert.equal(redactSecrets(benign), benign);
});

test('redaction is safe to apply twice (idempotent on redacted output)', () => {
  const once = redactSecrets('DB_PASSWORD=hunter2\nOPENAI_API_KEY=sk-abcdefghij1234567890');
  assert.equal(redactSecrets(once), once);
});

test('a mixed .env blob redacts secrets but keeps non-secret lines', () => {
  const blob = [
    'PORT=8080',
    'DATABASE_URL=postgres://u:p@h:5432/db',
    'GITHUB_TOKEN=ghp_abcdefghij1234567890',
    'LOG_LEVEL=debug',
  ].join('\n');
  const out = redactSecrets(blob);
  assert.match(out, /PORT=8080/);
  assert.match(out, /LOG_LEVEL=debug/);
  assert.doesNotMatch(out, /ghp_abcdefghij/);
  assert.doesNotMatch(out, /:p@h/);
});
