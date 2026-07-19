import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCredentialFile, resolveCredential } from '../src/credential.js';

const POSIX = process.platform !== 'win32';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'askup-cred-'));
}
function writeFile(dir, name, content, mode = 0o600) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  if (POSIX) fs.chmodSync(p, mode);
  return p;
}

test('readCredentialFile returns a trimmed single-line token', () => {
  const dir = tmp();
  const p = writeFile(dir, 'tok', 'sk-ant-oat-abc123\n');
  assert.equal(readCredentialFile(p), 'sk-ant-oat-abc123');
});

test('readCredentialFile rejects a multi-line file (no arbitrary-file exfil)', () => {
  const dir = tmp();
  const p = writeFile(dir, 'key.pem', '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n');
  assert.throws(() => readCredentialFile(p), (e) => e.kind === 'usage' && /multiple lines/.test(e.message));
});

test('readCredentialFile rejects an oversized file', () => {
  const dir = tmp();
  const p = writeFile(dir, 'big', 'x'.repeat(5000));
  assert.throws(() => readCredentialFile(p), (e) => e.kind === 'usage' && /too large/.test(e.message));
});

test('readCredentialFile rejects an empty file and a missing file', () => {
  const dir = tmp();
  assert.throws(() => readCredentialFile(writeFile(dir, 'empty', '   ')), /is empty/);
  assert.throws(() => readCredentialFile(path.join(dir, 'nope')), (e) => e.kind === 'usage' && /cannot read/.test(e.message));
});

test('readCredentialFile resolves a relative path against configDir', () => {
  const dir = tmp();
  writeFile(dir, 'tok', 'abc');
  assert.equal(readCredentialFile('tok', dir), 'abc');
});

if (POSIX) {
  test('readCredentialFile rejects a group/world-readable file (POSIX)', () => {
    const dir = tmp();
    const p = writeFile(dir, 'loose', 'abc', 0o644);
    assert.throws(() => readCredentialFile(p), (e) => e.kind === 'usage' && /group\/world-accessible/.test(e.message));
  });

  test('the perm check can be overridden for container mounts', () => {
    const dir = tmp();
    const p = writeFile(dir, 'loose', 'abc', 0o644);
    process.env.ASKUP_ALLOW_INSECURE_CREDENTIAL_PERMS = '1';
    try {
      assert.equal(readCredentialFile(p), 'abc');
    } finally {
      delete process.env.ASKUP_ALLOW_INSECURE_CREDENTIAL_PERMS;
    }
  });
}

test('resolveCredential prefers env, falls back to file, else null', () => {
  const dir = tmp();
  const p = writeFile(dir, 'tok', 'from-file');
  process.env.ASKUP_TEST_CRED = 'from-env';
  try {
    assert.equal(resolveCredential({ envName: 'ASKUP_TEST_CRED', filePath: p }), 'from-env');
  } finally {
    delete process.env.ASKUP_TEST_CRED;
  }
  assert.equal(resolveCredential({ envName: 'ASKUP_TEST_CRED_UNSET', filePath: p }), 'from-file');
  assert.equal(resolveCredential({ envName: 'ASKUP_TEST_CRED_UNSET' }), null);
});
