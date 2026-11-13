/**
 * DAQ approved-operators allowlist — who may send engine-control commands.
 *
 * Authorization is identity-based: Caddy injects `X-Auth-Email` on the WS upgrade
 * (from the session cookie), server.ts reads it, and this module answers whether
 * that person is an approved operator. Enforced per-command in server.ts, so it
 * cannot be bypassed by talking to the backend directly.
 *
 * The roster is a committed file (../operators.txt), re-read on change (mtime
 * cached). A missing/unreadable file returns an empty set → deny (fail-closed);
 * dev bypasses this entirely via the "no X-Auth-Email header" path in server.ts.
 * Override the path with DAQ_OPERATORS_FILE.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
// src/operators.ts and dist/operators.js both sit one level under backend/,
// so ../operators.txt resolves to backend/operators.txt either way.
const OPERATORS_FILE = process.env.DAQ_OPERATORS_FILE || path.join(_dir, '..', 'operators.txt');

let _cache: { mtimeMs: number; emails: Set<string> } | null = null;

function load(): Set<string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(OPERATORS_FILE);
  } catch {
    return new Set(); // missing → deny (fail-closed)
  }
  if (_cache && _cache.mtimeMs === stat.mtimeMs) return _cache.emails;

  const emails = new Set<string>();
  try {
    for (const raw of fs.readFileSync(OPERATORS_FILE, 'utf8').split('\n')) {
      const line = raw.split('#')[0].trim().toLowerCase();
      if (line) emails.add(line);
    }
  } catch {
    return new Set();
  }
  _cache = { mtimeMs: stat.mtimeMs, emails };
  return emails;
}

/** True if `email` is an approved DAQ operator (case-insensitive). */
export function isOperator(email: string): boolean {
  if (!email) return false;
  return load().has(email.trim().toLowerCase());
}
