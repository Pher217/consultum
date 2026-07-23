// Cross-platform launcher for the packed-tarball contract suite.
//
// The suite is gated behind CONSULTUM_RUN_CONTRACT=1 so a plain `node --test` (which auto-discovers
// test/contract/pack-contract.mjs) skips it. Setting that env var inline in an npm script
// (`CONSULTUM_RUN_CONTRACT=1 node ...`) is a Unix-shell-ism that Windows cmd/PowerShell rejects, so
// set it here in Node and spawn the runner — works identically on every platform, no cross-env dep.
import { spawnSync } from 'node:child_process';

const res = spawnSync(process.execPath, ['--test', 'test/contract/pack-contract.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, CONSULTUM_RUN_CONTRACT: '1' },
});
process.exit(res.status ?? 1);
