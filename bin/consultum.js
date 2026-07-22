#!/usr/bin/env node
// consultum CLI entry — a thin wrapper. All logic lives in src/cli.js (unit-tested there). Reads the
// question + context from STDIN for `consult` (never argv), maps commands, sets the process exit code.

import { readFileSync } from 'fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs, checkArgs, emitError, runConsult, runConfig, runDoctor, runInit, runInitInteractive, USAGE } from '../src/cli.js';
import { ConsultumError, KIND } from '../src/errors.js';

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// consultum is invoked BY other programs, so its stdin is machine-generated and can be arbitrarily
// large (a runaway log dump, a whole repo pasted as "context"). Reading it unbounded would buffer
// the lot and then ship it to a paid provider. Cap it, and say so rather than truncating silently.
const MAX_STDIN_BYTES = 1024 * 1024;

// Commands that accept flags. An input that is not one of these is an unknown command (handled with
// the usage text in main's default case), NOT a flag-validation target.
const COMMANDS = new Set(['consult', 'init', 'doctor', 'config']);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) {
      // A USAGE error (exit 10), not a bare Error — otherwise this escapes to main().catch and exits
      // 1 with prose, breaking the documented exit-code contract AND ignoring --json.
      throw new ConsultumError(
        KIND.USAGE,
        `input exceeds ${MAX_STDIN_BYTES / 1024} KB. Send the relevant excerpt, not the whole file — ` +
          'a bigger packet costs more and advises worse.',
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.version) {
    out(version());
    return;
  }

  if (flags.help || !command) {
    out(USAGE);
    process.exitCode = flags.help || command ? 0 : 10;
    return;
  }

  // Reject unknown/misused flags for a known command before doing any work (this is where a typo'd
  // --sensitve is caught). An unknown COMMAND falls through to the default case below with the usage.
  if (COMMANDS.has(command)) {
    const argErr = checkArgs(command, flags);
    if (argErr) {
      process.exitCode = emitError(argErr, flags, err);
      return;
    }
  }

  switch (command) {
    case 'consult': {
      let stdin;
      try {
        stdin = await readStdin();
      } catch (e) {
        // Oversized stdin (or any read failure) — honour --json and the exit-code contract.
        process.exitCode = emitError(e, flags, err);
        return;
      }
      process.exitCode = await runConsult({ stdin, flags, out, err });
      return;
    }
    case 'config':
      process.exitCode = await runConfig({ flags, out, err });
      return;
    case 'doctor':
      process.exitCode = await runDoctor({ flags, out, err });
      return;
    case 'init':
      if (flags.interactive) {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        // readline/promises leaves a pending question() UNRESOLVED when stdin hits EOF, so the
        // process would exit 0 having written nothing — a silent no-op. Race every prompt against
        // 'close' and fail loudly instead.
        let closed = false;
        const onClose = new Promise((resolve) => rl.once('close', () => { closed = true; resolve('__EOF__'); }));
        const ask = async (q) => {
          if (closed) throw new Error('input ended before the wizard finished');
          const answer = await Promise.race([rl.question(q), onClose]);
          if (answer === '__EOF__') throw new Error('input ended before the wizard finished');
          return answer;
        };
        try {
          process.exitCode = await runInitInteractive({ flags, out, err, ask });
        } catch (e) {
          err(`consultum init --interactive: ${e.message}`);
          err('Run `consultum init` (non-interactive) to write a template you can edit instead.');
          process.exitCode = 10;
        } finally {
          rl.close();
        }
        return;
      }
      process.exitCode = await runInit({ flags, out, err });
      return;
    default:
      err(`consultum: unknown command '${command}'\n\n${USAGE}`);
      process.exitCode = 10;
  }
}

main().catch((e) => {
  err(`consultum: fatal: ${e.message}`);
  process.exitCode = 1;
});
