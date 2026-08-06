// Smoke test for the human inbox (docs/human-inbox.md) — an asynchronous, folder-backed
// request/answer channel from an AGENT to a HUMAN. Like contrib/pair, this is an EXPERIMENTAL
// companion pattern, not part of the consultum CLI contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, mkdirSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(REPO_ROOT, 'contrib', 'inbox', 'inbox.sh');

// The channel is a POSIX shell script. Windows has no bash and no POSIX modes, which is why this
// is a companion pattern rather than part of the CLI contract (same rationale as contrib/pair).
const skip = process.platform === 'win32' ? 'POSIX-only (bash channel script)' : false;

// A minimal, controlled PATH — not the dev machine's real PATH, which may have its own
// `consultum` install (that would make the "redaction unavailable" test lie about what it's
// testing). Includes only what inbox.sh actually shells out to: node, and coreutils.
const NODE_DIR = dirname(process.execPath);
const BASE_PATH = [NODE_DIR, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

// Builds a fake `consultum` on PATH that resolves (via readlink -f) to this repo's real
// bin/consultum.js, so `dirname(dirname(real))` lands on this repo's src/redact.js — exactly
// the resolution chain inbox.sh performs against a real global install.
function withInbox(fn, { withConsultum = true, extraEnv = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'inbox-root-'));
  const binDir = mkdtempSync(join(tmpdir(), 'inbox-bin-'));
  if (withConsultum) {
    symlinkSync(join(REPO_ROOT, 'bin', 'consultum.js'), join(binDir, 'consultum'));
  }
  const PATH = withConsultum ? `${binDir}:${BASE_PATH}` : BASE_PATH;
  const env = { PATH, HOME: process.env.HOME, CONSULTUM_INBOX: root, ...extraEnv };
  // Trimmed convenience wrapper — fine for ids/status lines, but NEVER use it to assert an
  // answer body byte-for-byte: trimming hides trailing-newline/whitespace corruption.
  const inbox = (args, opts = {}) =>
    execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env, input: opts.input }).trim();
  // Untrimmed — for exact-body assertions.
  const inboxRaw = (args, opts = {}) =>
    execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env, input: opts.input });
  try {
    return fn(inbox, root, inboxRaw, env);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
}

test('ask writes an open question atomically and prints only the id', { skip }, () => {
  // GIVEN a fresh inbox root
  // WHEN a question is asked
  // THEN it exits 0, prints only the id on stdout, and open/<id>/{question.md,meta.json} exist
  //      with the question directory locked to 0700, and meta.json actually carries its
  //      required fields — schemaVersion 1, redacted true, an id matching what `ask` printed —
  //      and does NOT carry an `answered` field at all (B2: [ -f answer.md ] is the sole source
  //      of truth; a field that is written false and never flips is not kept around to drift)
  withInbox((inbox, root) => {
    const id = inbox(['ask', '--slug', 'smoke'], { input: '## Question\nShip it?\n' });
    assert.match(id, /^\d{8}T\d{6}Z-smoke-\d+-\d+$/);
    const dir = join(root, 'open', id);
    assert.equal(readFileSync(join(dir, 'question.md'), 'utf8'), '## Question\nShip it?\n');
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.redacted, true);
    assert.equal(meta.id, id);
    assert.ok(!('answered' in meta), 'meta.json must not carry an answered field');
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  });
});

test('check on an unanswered question exits 20 with empty stdout', { skip }, () => {
  // GIVEN a question with no answer yet
  // WHEN check is run
  // THEN it exits exactly 20 (pending — an expected non-success, not an error) and prints nothing
  withInbox((inbox) => {
    const id = inbox(['ask'], { input: 'q\n' });
    try {
      inbox(['check', id]);
      assert.fail('expected exit 20');
    } catch (err) {
      assert.equal(err.status, 20);
      assert.equal(err.stdout, '');
    }
  });
});

test('answer then check returns the answer body exactly', { skip }, () => {
  // GIVEN an open question
  // WHEN it is answered and then checked
  // THEN check exits 0 and prints EXACTLY the answer body, untrimmed — including the trailing
  //      newline, so trailing-whitespace corruption in the pipeline would be caught
  withInbox((inbox, root, inboxRaw) => {
    const id = inbox(['ask'], { input: 'q\n' });
    assert.match(inbox(['answer', id], { input: 'Yes, ship it.\n' }), /answered/);
    assert.equal(inboxRaw(['check', id]), 'Yes, ship it.\n');
  });
});

test('answering twice refuses and leaves the original answer untouched', { skip }, () => {
  // GIVEN an already-answered question
  // WHEN answer is called again
  // THEN it exits 10 and the original answer bytes are unchanged
  withInbox((inbox, root) => {
    const id = inbox(['ask'], { input: 'q\n' });
    inbox(['answer', id], { input: 'Original.\n' });
    try {
      inbox(['answer', id], { input: 'Overwrite attempt.\n' });
      assert.fail('expected exit 10');
    } catch (err) {
      assert.equal(err.status, 10);
    }
    assert.equal(readFileSync(join(root, 'open', id, 'answer.md'), 'utf8'), 'Original.\n');
  });
});

test('B1: a successful answer writes a complete answer.meta.json', { skip }, () => {
  // GIVEN an open question
  // WHEN it is answered
  // THEN answer.meta.json carries schemaVersion, id, ts, by, and surface (not the old
  //      two-field { answered, answered_at } stub)
  withInbox((inbox, root) => {
    const id = inbox(['ask'], { input: 'q\n' });
    inbox(['answer', id], { input: 'Yes.\n' });
    const meta = JSON.parse(readFileSync(join(root, 'open', id, 'answer.meta.json'), 'utf8'));
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.id, id);
    assert.equal(typeof meta.ts, 'string');
    assert.equal(meta.by, 'human:cli');
    assert.equal(meta.surface, 'cli');
  });
});

test('B1: answer publication is transactional — a failed metadata write must not publish answer.md', { skip }, () => {
  // GIVEN a question whose answer.meta.json path is pre-occupied by a directory, forcing the
  //       metadata publish step to fail
  // WHEN answer is attempted
  // THEN it exits non-zero, answer.md is never created, and the answer.claim lock is released
  //      (so a subsequent legitimate answer attempt is not left permanently blocked)
  withInbox((inbox, root) => {
    const id = inbox(['ask'], { input: 'q\n' });
    const dir = join(root, 'open', id);
    mkdirSync(join(dir, 'answer.meta.json'));
    assert.throws(() => inbox(['answer', id], { input: 'should not publish\n' }));
    assert.ok(!existsSync(join(dir, 'answer.md')), 'answer.md must not be published when metadata publish fails');
    assert.ok(!existsSync(join(dir, 'answer.claim')), 'the claim lock must be released after failure');
  });
});

test('wait without --timeout is a usage error and never polls', { skip }, () => {
  // GIVEN an open question
  // WHEN wait is called without --timeout
  // THEN it exits 10 immediately — no sleep loop is entered
  withInbox((inbox) => {
    const id = inbox(['ask'], { input: 'q\n' });
    const start = Date.now();
    try {
      inbox(['wait', id]);
      assert.fail('expected exit 10');
    } catch (err) {
      assert.equal(err.status, 10);
    }
    assert.ok(Date.now() - start < 1000, 'wait without --timeout must return immediately');
  });
});

test('wait times out at exit 21 when nothing answers in time', { skip }, () => {
  // GIVEN a question nobody answers
  // WHEN wait --timeout 2 is called
  // THEN it exits 21 within ~2-3s
  withInbox((inbox) => {
    const id = inbox(['ask'], { input: 'q\n' });
    const start = Date.now();
    try {
      inbox(['wait', id, '--timeout', '2']);
      assert.fail('expected exit 21');
    } catch (err) {
      assert.equal(err.status, 21);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 1800 && elapsed < 4000, `expected ~2s, got ${elapsed}ms`);
    }
  });
});

test('ask redacts secrets before anything touches disk', { skip }, () => {
  // GIVEN a question body containing a live-shaped secret
  // WHEN it is asked
  // THEN question.md on disk contains no substring of the raw secret
  withInbox((inbox, root) => {
    const id = inbox(['ask'], { input: 'GITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAA\nplease review\n' });
    const onDisk = readFileSync(join(root, 'open', id, 'question.md'), 'utf8');
    assert.doesNotMatch(onDisk, /ghp_AAAA/);
    assert.match(onDisk, /\[REDACTED\]/);
  });
});

test('ask hard-fails and writes nothing when redaction cannot be resolved', { skip }, () => {
  // GIVEN a PATH with no `consultum` binary on it
  // WHEN ask is called
  // THEN it exits non-zero and open/ itself does not exist at all — not merely "no question.md",
  //      which a stray open/.tmp.* working dir or a partial-metadata write would also satisfy
  withInbox((inbox, root) => {
    assert.throws(() => inbox(['ask'], { input: 'q\n' }));
    const openDir = join(root, 'open');
    assert.ok(!existsSync(openDir), 'open/ must not exist when redaction cannot be resolved');
  }, { withConsultum: false });
});

test('B4: a PATH-poisoned consultum package with the wrong identity is rejected', { skip }, () => {
  // GIVEN a fake `consultum` on PATH that resolves to a package that is NOT named "consultum"
  //       (a plausible PATH-poisoning shape: same bin/src layout, different package.json name)
  // WHEN ask is called
  // THEN it hard-fails and writes nothing — resolving redact.js by walking from PATH must verify
  //      the package identity before trusting the module it finds there
  withInbox((inbox, root) => {
    const fakePkg = mkdtempSync(join(tmpdir(), 'inbox-fakepkg-'));
    mkdirSync(join(fakePkg, 'bin'));
    mkdirSync(join(fakePkg, 'src'));
    writeFileSync(join(fakePkg, 'package.json'), JSON.stringify({ name: 'not-consultum' }));
    writeFileSync(join(fakePkg, 'bin', 'consultum.js'), '#!/usr/bin/env node\n');
    writeFileSync(
      join(fakePkg, 'src', 'redact.js'),
      'export function redactSecrets(s) { return s; }\n', // a working redactor — identity is the gate, not functionality
    );
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'inbox-fakebin-'));
    symlinkSync(join(fakePkg, 'bin', 'consultum.js'), join(fakeBinDir, 'consultum'));
    // withInbox's own `inbox` helper builds its own PATH (pointing at the real consultum); call
    // bash directly so PATH resolves only to our fake, mis-identified package.
    try {
      assert.throws(() => execFileSync('bash', [SCRIPT, 'ask'], {
        encoding: 'utf8',
        env: { PATH: `${fakeBinDir}:${BASE_PATH}`, HOME: process.env.HOME, CONSULTUM_INBOX: root },
        input: 'q\n',
      }));
      assert.ok(!existsSync(join(root, 'open')), 'open/ must not exist when package identity fails');
    } finally {
      rmSync(fakePkg, { recursive: true, force: true });
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });
});

test('B3: a chmod failure on the inbox root refuses to publish, not silently ignored', {
  skip: process.platform !== 'darwin' ? 'requires macOS chflags to force a chmod failure' : false,
}, () => {
  // GIVEN an inbox root marked immutable (chflags uchg) so `chmod 700` on it fails, while writes
  //       inside its already-writable open/ subdirectory still succeed — isolating the chmod
  //       failure from every other side effect `ask` performs
  // WHEN ask is called
  // THEN it exits non-zero and publishes no question directory — the chmod failure must not be
  //      swallowed with `|| true`
  withInbox((inbox, root) => {
    mkdirSync(join(root, 'open'), { recursive: true });
    // mkdtempSync already creates `root` at mode 0700 — chmod 700 on an unchanged mode is a
    // macOS no-op that doesn't trip the immutable-flag check at all. Force a real mode change
    // (755) first so the forthcoming `chmod 700` genuinely has to write, and uchg can block it.
    execFileSync('chmod', ['755', root]);
    execFileSync('chflags', ['uchg', root]);
    try {
      assert.throws(() => inbox(['ask', '--slug', 'b3'], { input: 'q\n' }));
      const entries = existsSync(join(root, 'open')) ? readdirSync(join(root, 'open')) : [];
      assert.deepEqual(entries, [], 'no question directory may be published when chmod fails');
    } finally {
      execFileSync('chflags', ['nouchg', root]);
    }
  });
});

test('a forged answered flag in meta.json does not fool check', { skip }, () => {
  // GIVEN a question whose meta.json has been hand-edited to claim answered:true, with no answer.md
  // WHEN check is run
  // THEN it still exits 20 — the source of truth is [ -f answer.md ], not the meta.json mirror
  withInbox((inbox, root) => {
    const id = inbox(['ask'], { input: 'q\n' });
    const metaPath = join(root, 'open', id, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    meta.answered = true;
    writeFileSync(metaPath, JSON.stringify(meta));
    try {
      inbox(['check', id]);
      assert.fail('expected exit 20');
    } catch (err) {
      assert.equal(err.status, 20);
    }
  });
});

test('a path-traversal slug is rejected and nothing is written outside the root', { skip }, () => {
  // GIVEN a malicious --slug
  // WHEN ask is called
  // THEN it exits non-zero and no directory escaping the root is created
  withInbox((inbox, root) => {
    assert.throws(() => inbox(['ask', '--slug', '../../etc/evil'], { input: 'q\n' }));
    assert.ok(!existsSync(join(root, '..', 'etc')));
    assert.ok(!existsSync('/tmp/etc'));
  });
});

test('the default inbox root is not nested under pair.sh\'s root', { skip }, () => {
  // GIVEN the default root (CONSULTUM_INBOX unset)
  // WHEN it is resolved
  // THEN it does not live under pair.sh's $HOME/.claude/consult — nesting there lets
  //      `pair.sh close inbox` (no --force) silently rm -rf a populated inbox, because pair's
  //      unanswered-work guard counts request-*.md files this layout never creates
  withInbox((inbox) => {
    const root = execFileSync('bash', [SCRIPT, 'root'], {
      encoding: 'utf8',
      env: { PATH: BASE_PATH, HOME: process.env.HOME },
    }).trim();
    assert.doesNotMatch(root, /\/consult\//);
    assert.equal(root, join(process.env.HOME, '.claude', 'inbox'));
  }, {});
});

test('close moves the whole question directory into closed/', { skip }, () => {
  // GIVEN an answered open question
  // WHEN it is closed
  // THEN open/<id> no longer exists and closed/<id> contains its files
  withInbox((inbox, root) => {
    const id = inbox(['ask'], { input: 'q\n' });
    inbox(['answer', id], { input: 'ok\n' });
    assert.match(inbox(['close', id]), new RegExp(`closed ${id}`));
    assert.ok(!existsSync(join(root, 'open', id)));
    assert.ok(existsSync(join(root, 'closed', id, 'question.md')));
    assert.ok(existsSync(join(root, 'closed', id, 'answer.md')));
  });
});

test('prune never touches open/, even when questions are old', { skip }, () => {
  // GIVEN one open and one closed question, both eligible by age
  // WHEN prune --days 0 runs
  // THEN the closed one is removed and the open one is untouched
  withInbox((inbox, root) => {
    const openId = inbox(['ask'], { input: 'stays open\n' });
    const closedId = inbox(['ask'], { input: 'gets closed\n' });
    inbox(['answer', closedId], { input: 'ok\n' });
    inbox(['close', closedId]);
    const out = inbox(['prune', '--days', '0']);
    assert.match(out, /pruned 1/);
    assert.ok(existsSync(join(root, 'open', openId, 'question.md')), 'open question must survive prune');
    assert.ok(!existsSync(join(root, 'closed', closedId)), 'closed question must be pruned');
  });
});

test('prune --days 7 leaves a recently-closed record untouched', { skip }, () => {
  // GIVEN a closed question that was just closed (age ~0)
  // WHEN prune --days 7 runs
  // THEN it is NOT deleted — an implementation that deletes every closed record regardless of
  //      age would wrongly pass a --days 0 test but must fail this one
  withInbox((inbox, root) => {
    const closedId = inbox(['ask'], { input: 'gets closed\n' });
    inbox(['answer', closedId], { input: 'ok\n' });
    inbox(['close', closedId]);
    const out = inbox(['prune', '--days', '7']);
    assert.match(out, /pruned 0/);
    assert.ok(existsSync(join(root, 'closed', closedId, 'question.md')), 'recent closed question must survive prune --days 7');
  });
});

test('root prints the default absolute path and creates nothing', { skip }, () => {
  // GIVEN CONSULTUM_INBOX is unset
  // WHEN `root` is called
  // THEN it prints the default path, exits 0, and creates no directory as a side effect
  const before = existsSync(join(process.env.HOME, '.claude', 'inbox'));
  const out = execFileSync('bash', [SCRIPT, 'root'], {
    encoding: 'utf8',
    env: { PATH: BASE_PATH, HOME: process.env.HOME },
  }).trim();
  assert.equal(out, join(process.env.HOME, '.claude', 'inbox'));
  assert.equal(existsSync(join(process.env.HOME, '.claude', 'inbox')), before, 'root must not create the directory');
});

test('root prints exactly CONSULTUM_INBOX when set', { skip }, () => {
  // GIVEN CONSULTUM_INBOX pointing at an arbitrary temp path
  // WHEN `root` is called
  // THEN it prints exactly that path, verbatim
  const custom = join(tmpdir(), 'inbox-root-probe-does-not-exist');
  const out = execFileSync('bash', [SCRIPT, 'root'], {
    encoding: 'utf8',
    env: { PATH: BASE_PATH, HOME: process.env.HOME, CONSULTUM_INBOX: custom },
  }).trim();
  assert.equal(out, custom);
  assert.ok(!existsSync(custom));
});

test('watch does not emit the body of a sensitive question', { skip }, async () => {
  // GIVEN a sensitive question already on disk before watch starts
  // WHEN watch runs briefly and is then killed
  // THEN its ask-line for that id appears (proving watch actually saw it) but never contains the
  //      question body — only an opaque marker
  const root = mkdtempSync(join(tmpdir(), 'inbox-root-'));
  const binDir = mkdtempSync(join(tmpdir(), 'inbox-bin-'));
  symlinkSync(join(REPO_ROOT, 'bin', 'consultum.js'), join(binDir, 'consultum'));
  const env = { PATH: `${binDir}:${BASE_PATH}`, HOME: process.env.HOME, CONSULTUM_INBOX: root };
  let child;
  try {
    const id = execFileSync('bash', [SCRIPT, 'ask', '--sensitive'], {
      encoding: 'utf8', env, input: 'SECRET_BODY_MARKER_XYZ\n',
    }).trim();

    child = spawn('bash', [SCRIPT, 'watch'], { env });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    child.kill('SIGKILL');
    child = null;
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.match(out, new RegExp(`INBOX\\[ask\\] ${id}`), 'watch must have observed the sensitive ask');
    assert.doesNotMatch(out, /SECRET_BODY_MARKER_XYZ/);
  } finally {
    if (child) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});
