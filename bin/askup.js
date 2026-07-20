#!/usr/bin/env node
// askup CLI entry — a thin wrapper. All logic lives in src/cli.js (unit-tested there). Reads the
// question + context from STDIN for `consult` (never argv), maps commands, sets the process exit code.

import { readFileSync } from 'fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs, runConsult, runConfig, runDoctor, runInit, runInitInteractive, USAGE } from '../src/cli.js';

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

// askup is invoked BY other programs, so its stdin is machine-generated and can be arbitrarily
// large (a runaway log dump, a whole repo pasted as "context"). Reading it unbounded would buffer
// the lot and then ship it to a paid provider. Cap it, and say so rather than truncating silently.
const MAX_STDIN_BYTES = 1024 * 1024;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(
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

  switch (command) {
    case 'consult': {
      const stdin = await readStdin();
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
          err(`askup init --interactive: ${e.message}`);
          err('Run `askup init` (non-interactive) to write a template you can edit instead.');
          process.exitCode = 10;
        } finally {
          rl.close();
        }
        return;
      }
      process.exitCode = runInit({ flags, out, err });
      return;
    default:
      err(`askup: unknown command '${command}'\n\n${USAGE}`);
      process.exitCode = 10;
  }
}

main().catch((e) => {
  err(`askup: fatal: ${e.message}`);
  process.exitCode = 1;
});
