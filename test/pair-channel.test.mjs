// Smoke test for the paired-sessions channel (docs/paired-sessions.md).
//
// The channel is an EXPERIMENTAL companion pattern, not part of the consultum CLI
// contract — so this covers the three defects that made the original file-channel
// lose messages in production, and nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'contrib', 'pair', 'pair.sh');

// The channel is a POSIX shell script. Windows has no bash and no POSIX modes,
// which is why this is a companion pattern rather than part of the CLI contract.
const skip = process.platform === 'win32' ? 'POSIX-only (bash channel script)' : false;

function withChannel(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pair-'));
  const pair = (...args) =>
    execFileSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PAIR_HOME: home, PAIR_NAME: 'test' },
    }).trim();
  try {
    return fn(pair, home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function body(dir, name, text) {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
}

test('a question survives a full round trip', { skip }, () => {
  // GIVEN an initialised channel
  // WHEN one side asks and the other answers that ID
  // THEN `wait` returns the answer body
  withChannel((pair, home) => {
    pair('init', 't');
    const id = pair('ask', 't', '--file', body(home, 'q.md', '## Question\nShip it?\n'));
    pair('answer', 't', id, '--file', body(home, 'a.md', '## Verdict\nYes.\n'));
    assert.match(pair('wait', 't', id, '30'), /## Verdict\nYes\./);
  });
});

test('messages sent within the same second do not overwrite each other', { skip }, () => {
  // GIVEN three questions asked in rapid succession
  // WHEN their IDs are compared
  // THEN all three are distinct, so no message is silently lost
  // (a bare `date -u +%Y%m%dT%H%M%S` ID collides here and the second write wins)
  withChannel((pair, home) => {
    pair('init', 't');
    const f = body(home, 'q.md', 'q\n');
    const ids = [1, 2, 3].map(() => pair('ask', 't', '--file', f));
    assert.equal(new Set(ids).size, 3);
  });
});

test('a reader never observes a partially written message', { skip }, () => {
  // GIVEN a response being assembled in the channel directory
  // WHEN a reader polls for response-<ID>.md before the write completes
  // THEN the file does not exist yet — publication is a rename, so it appears whole
  withChannel((pair, home) => {
    pair('init', 't');
    const id = pair('ask', 't', '--file', body(home, 'q.md', 'q\n'));
    const chan = join(home, 't');
    writeFileSync(join(chan, '.tmp.partial'), '## Verdict\nHalf-writ');
    assert.throws(() => readFileSync(join(chan, `response-${id}.md`)), /ENOENT/);
    pair('answer', 't', id, '--file', body(home, 'a.md', '## Verdict\nWhole.\n'));
    assert.match(readFileSync(join(chan, `response-${id}.md`), 'utf8'), /Whole\./);
  });
});

test('waiting past the deadline fails loudly instead of hanging', { skip }, () => {
  // GIVEN a question nobody answers
  // WHEN the wait deadline passes
  // THEN it exits 2 and names the unanswered ID, so the asker can fall back
  withChannel((pair, home) => {
    pair('init', 't');
    const id = pair('ask', 't', '--file', body(home, 'q.md', 'q\n'));
    try {
      pair('wait', 't', id, '1');
      assert.fail('expected a non-zero exit');
    } catch (err) {
      assert.equal(err.status, 2);
      assert.match(err.stderr, new RegExp(`TIMEOUT.*${id}`, 's'));
    }
  });
});

test('status separates open requests from answered ones', { skip }, () => {
  // GIVEN one answered and one unanswered request
  // WHEN status is read
  // THEN it reports exactly 1 answered and 1 open
  withChannel((pair, home) => {
    pair('init', 't');
    const f = body(home, 'q.md', 'q\n');
    const answered = pair('ask', 't', '--file', f);
    pair('ask', 't', '--file', f);
    pair('answer', 't', answered, '--file', body(home, 'a.md', 'ok\n'));
    assert.match(pair('status', 't'), /1 answered, 1 open/);
  });
});

test('closing refuses to discard a channel someone is still blocked on', { skip }, () => {
  // GIVEN a channel with an unanswered request
  // WHEN close is called without --force
  // THEN it refuses and says how many requests are open
  withChannel((pair, home) => {
    pair('init', 't');
    pair('ask', 't', '--file', body(home, 'q.md', 'q\n'));
    assert.throws(() => pair('close', 't'), /1 unanswered request/);
    assert.match(pair('close', 't', '--force'), /closed t \(forced\)/);
  });
});

test('the channel directory is not readable by other users', { skip }, () => {
  // GIVEN messages that quote working context and private repo paths
  // WHEN the channel is created
  // THEN its mode is 700
  withChannel((pair, home) => {
    pair('init', 't');
    // statSync, not `stat` — the BSD and GNU flags for this differ.
    assert.equal(statSync(join(home, 't')).mode & 0o777, 0o700);
  });
});

test('a fresh watcher announces each message exactly once', { skip }, () => {
  // GIVEN two messages already in the channel
  // WHEN the watcher sweeps twice (seen-markers persist on disk)
  // THEN the second sweep announces nothing
  withChannel((pair, home) => {
    pair('init', 't');
    const f = body(home, 'q.md', 'q\n');
    pair('ask', 't', '--file', f);
    pair('ask', 't', '--file', f);
    // spawnSync with a timeout, not `timeout(1)` — that binary is absent from a
    // stock macOS. The watcher is unbounded by design, so killing it is the exit.
    const sweep = () =>
      spawnSync('bash', [SCRIPT, 'watch', 't'], {
        encoding: 'utf8',
        timeout: 6000,
        killSignal: 'SIGKILL',
        env: { ...process.env, PAIR_HOME: home },
      }).stdout ?? '';
    assert.equal(sweep().trim().split('\n').filter(Boolean).length, 2);
    assert.equal(sweep().trim(), '');
  });
});

test('IDs are identifiers, not sortable timestamps', { skip }, () => {
  // GIVEN an agent sandbox whose clock runs ahead of the filesystem's
  // WHEN status reports latency
  // THEN it uses real file times, so a future-dated ID does not produce a negative wait
  withChannel((pair, home) => {
    pair('init', 't');
    const chan = join(home, 't');
    mkdirSync(join(chan, '.seen'), { recursive: true });
    writeFileSync(join(chan, 'request-20990101T000000-1-1.md'), '# Consult\nfrom a fast clock\n');
    const out = pair('status', 't');
    assert.match(out, /20990101T000000-1-1\s+OPEN/);
    assert.doesNotMatch(out, /-\d+s waiting/);
  });
});
