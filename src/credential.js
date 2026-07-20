// Credential resolution for adapters — one place so the safety gates exist exactly once (
// review). A credential may come from an env var (12-factor, preferred) or a file (the keychain-free
// path for sandboxed callers). File reads are the risky part: a config an attacker can write could
// point `api_key_file` at an SSH key or `.env` and exfiltrate it as a Bearer header (threat-model A7).
// So file reads pass a SHAPE GATE — single line, size-capped, POSIX-perm-checked, path resolved
// relative to the config file's directory — which makes an arbitrary file fail rather than be sent.

import fs from 'fs';
import path from 'path';
import { AskupError, KIND } from './errors.js';

const MAX_CREDENTIAL_BYTES = 4096;

// Read a credential from a file with the shape gate. Throws USAGE (a loud config error) on any
// violation — never returns a value that failed a check.
export function readCredentialFile(filePath, configDir, label = 'credential') {
  // Relative paths resolve against the CONFIG file's directory (stamped by loadConfig). In library
  // mode with no config file, configDir is null and paths resolve against cwd — trusted-caller only.
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(configDir || process.cwd(), filePath);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new AskupError(KIND.USAGE, `${label}: cannot read credential file ${abs}`);
  }
  if (!stat.isFile()) throw new AskupError(KIND.USAGE, `${label}: ${abs} is not a file`);
  if (stat.size > MAX_CREDENTIAL_BYTES) {
    throw new AskupError(
      KIND.USAGE,
      `${label}: ${abs} is ${stat.size} bytes (> ${MAX_CREDENTIAL_BYTES}) — too large to be a credential; refusing to send it`,
    );
  }
  // POSIX perm check: a credential file must not be group/world-accessible. Skipped on Windows,
  // where fs mode bits are not meaningful. Escape hatch for container-mounted secrets.
  if (process.platform !== 'win32' && !process.env.ASKUP_ALLOW_INSECURE_CREDENTIAL_PERMS) {
    if ((stat.mode & 0o077) !== 0) {
      throw new AskupError(
        KIND.USAGE,
        `${label}: ${abs} is group/world-accessible — run \`chmod 600 ${abs}\` (or set ASKUP_ALLOW_INSECURE_CREDENTIAL_PERMS=1 to override)`,
      );
    }
  }
  const val = fs.readFileSync(abs, 'utf8').trim();
  if (!val) throw new AskupError(KIND.USAGE, `${label}: ${abs} is empty`);
  if (/[\r\n]/.test(val)) {
    throw new AskupError(KIND.USAGE, `${label}: ${abs} has multiple lines — a credential must be a single line; refusing to send it`);
  }
  return val;
}

// Resolve a credential: env var if set (preferred), else a file (with the gate), else null.
// `null` means "not configured / not present" — the adapter decides whether that's fatal.
export function resolveCredential({ envName, filePath, configDir, label } = {}) {
  if (envName && process.env[envName]) return process.env[envName];
  if (filePath) return readCredentialFile(filePath, configDir, label || envName || 'credential');
  return null;
}
