// Cross-platform syntax lint: `node --check` every source file. Replaces a bash-only for-loop so
// `npm run lint` works on Windows too (dev-only; not published — scripts/ is outside the files allowlist).
import { execFileSync } from 'child_process';
import { readdirSync } from 'fs';

const files = [
  'bin/consultum.js',
  ...readdirSync('src').filter((f) => f.endsWith('.js')).map((f) => `src/${f}`),
  ...readdirSync('src/providers').filter((f) => f.endsWith('.js')).map((f) => `src/providers/${f}`),
];

for (const f of files) execFileSync(process.execPath, ['--check', f]);
console.log(`lint ok — ${files.length} files`);
