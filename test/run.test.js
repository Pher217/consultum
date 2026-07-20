// run.js is the only module that touches REAL subprocesses and REAL HTTP — everything else fakes it
// via dependency injection. That left the "fail fast on stall" guarantee, the SIGKILL-on-timeout
// path, and the non-2xx behaviour asserted nowhere. These tests are hermetic: short-lived `node -e`
// children and a loopback http server, no provider credentials, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { runWithStdin, httpPostJson, MAX_SUBPROCESS_OUTPUT_BYTES } from '../src/run.js';

const NODE = process.execPath;

test('runWithStdin returns the child exit code and stdout', async () => {
  const res = await runWithStdin(NODE, ['-e', 'process.stdout.write("hello"); process.exit(0)'], { timeoutMs: 10_000 });
  assert.equal(res.code, 0);
  assert.equal(res.stdout, 'hello');
  assert.equal(res.timedOut, false);
});

test('runWithStdin surfaces a non-zero exit code rather than swallowing it', async () => {
  const res = await runWithStdin(NODE, ['-e', 'process.exit(3)'], { timeoutMs: 10_000 });
  assert.equal(res.code, 3);
  assert.equal(res.timedOut, false);
});

test('runWithStdin feeds stdin to the child (the prompt never goes on argv)', async () => {
  const script = 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write("got:"+d))';
  const res = await runWithStdin(NODE, ['-e', script], { timeoutMs: 10_000, input: 'SECRET_PROMPT' });
  assert.equal(res.stdout, 'got:SECRET_PROMPT');
});

test('runWithStdin KILLS a hung child and reports timedOut — the fail-fast guarantee', async () => {
  const started = Date.now();
  const res = await runWithStdin(NODE, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 });
  assert.equal(res.timedOut, true, 'a child that outlives the timeout must be reported as timedOut');
  assert.ok(Date.now() - started < 15_000, 'must not wait for the child to finish on its own');
});

test('runWithStdin reports a spawn failure instead of throwing', async () => {
  const res = await runWithStdin('consultum-no-such-binary-xyz', [], { timeoutMs: 5_000 });
  assert.equal(res.code, -1);
  assert.match(res.stderr, /ENOENT|not found|spawn/i);
});

test('runWithStdin caps runaway child output instead of buffering without bound', async () => {
  const script = `const c="x".repeat(1024*1024); for(let i=0;i<12;i++) process.stdout.write(c);`;
  const res = await runWithStdin(NODE, ['-e', script], { timeoutMs: 30_000 });
  assert.ok(
    res.stdout.length <= MAX_SUBPROCESS_OUTPUT_BYTES,
    `stdout grew to ${res.stdout.length}, above the ${MAX_SUBPROCESS_OUTPUT_BYTES} cap`,
  );
});

// --- httpPostJson --------------------------------------------------------------------------------

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}

test('httpPostJson posts JSON and parses the response', async () => {
  const { s, url } = await server((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ echoed: JSON.parse(body) }));
    });
  });
  try {
    const out = await httpPostJson(url, { a: 1 }, { timeoutMs: 5_000 });
    assert.deepEqual(out, { echoed: { a: 1 } });
  } finally {
    s.close();
  }
});

test('httpPostJson throws on a non-2xx and includes the status and body', async () => {
  const { s, url } = await server((req, res) => {
    res.statusCode = 500;
    res.end('upstream exploded');
  });
  try {
    await assert.rejects(() => httpPostJson(url, {}, { timeoutMs: 5_000 }), /500/);
    await assert.rejects(() => httpPostJson(url, {}, { timeoutMs: 5_000 }), /upstream exploded/);
  } finally {
    s.close();
  }
});

test('httpPostJson throws on an unparseable body rather than returning silently', async () => {
  const { s, url } = await server((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('not json at all');
  });
  try {
    await assert.rejects(() => httpPostJson(url, {}, { timeoutMs: 5_000 }));
  } finally {
    s.close();
  }
});

test('a timeout says it TIMED OUT, for how long, and what to change', async () => {
  const { s, url } = await server(() => {
    /* never respond */
  });
  try {
    await assert.rejects(
      () => httpPostJson(url, {}, { timeoutMs: 200 }),
      (e) => {
        assert.match(e.message, /timed out after/i, 'must name the failure as a timeout');
        assert.match(e.message, /timeout_ms/, 'must tell the user the knob to turn');
        assert.doesNotMatch(e.message, /^This operation was aborted$/, 'must not surface the raw AbortError');
        return true;
      },
    );
  } finally {
    s.close();
  }
});
