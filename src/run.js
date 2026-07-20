// Low-level runtime primitives shared by the provider adapters: subprocess invocation (two stdin
// disciplines) and a JSON HTTP POST. Each honors a hard timeout — the "fail fast on stall" guard
// ported from the Codex guardrails. Adapters receive these via dependency injection so the contract
// tests can run without any live provider (see test/providers.test.js).

import { spawn } from 'child_process';
import fs from 'fs';

// Run a command with stdin bound to a REAL /dev/null (NOT an empty pipe). Codex `exec` prints
// "Reading additional input from stdin..." and hangs/empties when stdin is a pipe — it needs a real
// EOF'd stdin to use the arg prompt. On Windows, /dev/null does not exist; we fall back to 'ignore'
// (see docs/windows.md). Ported verbatim from coding-structure execute-task.
export function runNoStdin(cmd, args, { cwd, timeoutMs, env } = {}) {
  return new Promise((resolve) => {
    let devnull;
    try {
      devnull = fs.openSync(process.platform === 'win32' ? 'NUL' : '/dev/null', 'r');
    } catch {
      devnull = 'ignore';
    }
    const child = spawn(cmd, args, { cwd, stdio: [devnull, 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err, timedOut });
    });
  });
}

// Run a command feeding `input` on stdin (so the prompt never touches argv — argv leaks to `ps` and
// shell history; §18/threat-model A6). Used by anthropic-cli: `claude -p` reads the prompt from stdin.
export function runWithStdin(cmd, args, { cwd, timeoutMs, input = '', env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
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
// silently on failure. Uses the built-in global fetch (Node >=18/20/22).
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
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const defaultRuntime = { runNoStdin, runWithStdin, httpPostJson };
