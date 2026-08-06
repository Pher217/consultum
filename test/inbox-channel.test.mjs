// Smoke test for the human inbox (docs/human-inbox.md) — an asynchronous, folder-backed
// request/answer channel from an AGENT to a HUMAN. Like contrib/pair, this is an EXPERIMENTAL
// companion pattern, not part of the consultum CLI contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync,
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
  const inbox = (args, opts = {}) =>
    execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { PATH, HOME: process.env.HOME, CONSULTUM_INBOX: root, ...extraEnv },
      input: opts.input,
    }).trim();
  try {
    return fn(inbox, root);
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
  //      required fields — not merely present, but schemaVersion 1, redacted true, answered
  //      false, and an id matching what `ask` printed
  withInbox((inbox, root) => {
    const id = inbox(['ask', '--slug', 'smoke'], { input: '## Question\nShip it?\n' });
    assert.match(id, /^\d{8}T\d{6}Z-smoke-\d+-\d+$/);
    const dir = join(root, 'open', id);
    assert.equal(readFileSync(join(dir, 'question.md'), 'utf8'), '## Question\nShip it?\n');
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.redacted, true);
    assert.equal(meta.answered, false);
    assert.equal(meta.id, id);
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
  // THEN check exits 0 and prints exactly the answer body
  withInbox((inbox) => {
    const id = inbox(['ask'], { input: 'q\n' });
    assert.match(inbox(['answer', id], { input: 'Yes, ship it.\n' }), /answered/);
    assert.equal(inbox(['check', id]), 'Yes, ship it.');
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
  // THEN it exits non-zero and no question.md exists anywhere under the root
  withInbox((inbox, root) => {
    assert.throws(() => inbox(['ask'], { input: 'q\n' }));
    const openDir = join(root, 'open');
    assert.ok(!existsSync(openDir) || spawnSync('find', [openDir, '-name', 'question.md']).stdout.toString().trim() === '');
  }, { withConsultum: false });
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
