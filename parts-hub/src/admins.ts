// Parts Hub admins (replace a part's file, delete a part). Same model as
// daq-server's operators.txt: a committed allowlist, re-read when it changes
// (mtime-cached), and a missing or unreadable file means no admins (fail-closed).
// Override the path with PARTS_ADMINS_FILE.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

const FILE = process.env.PARTS_ADMINS_FILE || path.join(import.meta.dirname, '..', 'config', 'admins.txt');
let cache: { mtimeMs: number; emails: Set<string> } | null = null;

function load(): Set<string> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(FILE);
  } catch {
    return new Set();
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache.emails;
  const emails = new Set<string>();
  try {
    for (const raw of fs.readFileSync(FILE, 'utf8').split('\n')) {
      const line = raw.split('#')[0].trim().toLowerCase();
      if (line) emails.add(line);
    }
  } catch {
    return new Set();
  }
  cache = { mtimeMs: stat.mtimeMs, emails };
  return emails;
}

/** True if `email` may use the admin tools. In AUTH_MODE=dev everyone is (local only). */
export function isAdmin(email: string): boolean {
  if (config.auth.mode === 'dev') return true;
  return Boolean(email) && load().has(email.trim().toLowerCase());
}
