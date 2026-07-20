// Low-level runtime primitives shared by the provider adapters: subprocess invocation (two stdin
// disciplines) and a JSON HTTP POST. Each honors a hard timeout — the "fail fast on stall" guard
// ported from the Codex guardrails. Adapters receive these via dependency injection so the contract
// tests can run without any live provider (see test/providers.test.js).

import { spawn } from 'child_process';

// Cap on how much a subprocess may emit. A provider (or a compromised one) that streams without end
// would otherwise grow these buffers until the process dies. We keep the head and stop appending —
// the parse contract only needs the structured sections, which come well inside this bound.
export const MAX_SUBPROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

function capped(prev, chunk, truncatedFlag) {
  if (prev.length >= MAX_SUBPROCESS_OUTPUT_BYTES) {
    truncatedFlag.hit = true;
    return prev;
  }
  const next = prev + chunk;
  if (next.length > MAX_SUBPROCESS_OUTPUT_BYTES) {
    truncatedFlag.hit = true;
    return next.slice(0, MAX_SUBPROCESS_OUTPUT_BYTES);
  }
  return next;
}

// Run a command feeding `input` on stdin (so the prompt never touches argv — argv leaks to `ps` and
// shell history; threat-model A6). Used by every CLI adapter: `claude -p` and `codex exec -` both
// read the prompt from stdin. There is no argv-prompt variant on purpose.
export function runWithStdin(cmd, args, { cwd, timeoutMs, input = '', env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined });
    let out = '';
    let err = '';
    let timedOut = false;
    const truncated = { hit: false };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out = capped(out, d, truncated)));
    child.stderr.on('data', (d) => (err = capped(err, d, truncated)));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
    try {
      child.stdin.write(input);
      child.stdin.end();
    } catch {
      /* child may have exited already */
    }
  });
}

// POST JSON with a timeout. Throws on network error, non-2xx, or unparseable body — never returns
// silently on failure. Uses the built-in global fetch (Node >=20).
export async function httpPostJson(url, body, { headers = {}, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return await res.json();
  } catch (err) {
    // fetch surfaces a timeout as a bare "This operation was aborted", which tells a user neither
    // that it WAS a timeout, nor how long it waited, nor what to change. Say all three.
    if (err?.name === 'AbortError' || /aborted/i.test(err?.message ?? '')) {
      throw new Error(
        `timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s waiting for ${new URL(url).host}` +
          ' — the model may still be loading, or the host is busy. Raise `timeout_ms` for this model,' +
          ' or try a smaller/already-loaded model.',
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const defaultRuntime = { runWithStdin, httpPostJson };
