#!/usr/bin/env node
// askup CLI entry — a thin wrapper. All logic lives in src/cli.js (unit-tested there). Reads the
// question + context from STDIN for `consult` (never argv), maps commands, sets the process exit code.

import { parseArgs, runConsult, runConfig, runDoctor, runInit, USAGE } from '../src/cli.js';

const out = (s) => process.stdout.write(`${s}\n`);
const err = (s) => process.stderr.write(`${s}\n`);

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

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
