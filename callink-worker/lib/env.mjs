// Secrets come from one file only its owner can read: $CALLINK_ENV, default
// ~/.config/star/callink.env, as KEY=value lines. Real environment variables win, so
// a container can pass them in instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENV_FILE = process.env.CALLINK_ENV ?? path.join(os.homedir(), '.config/star/callink.env');

export function readEnv(required = []) {
  let file = {};
  if (fs.existsSync(ENV_FILE)) {
    if (fs.statSync(ENV_FILE).mode & 0o077) throw new Error(`${ENV_FILE} is readable by others; chmod 600 it`);
    file = Object.fromEntries(
      fs.readFileSync(ENV_FILE, 'utf8').split('\n')
        .map(l => l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map(m => [m[1], m[2]]),
    );
  }
  const env = { ...file };
  for (const k of required) if (process.env[k]) env[k] = process.env[k];
  const missing = required.filter(k => !env[k]);
  if (missing.length) throw new Error(`set ${missing.join(', ')} (in ${ENV_FILE} or the environment)`);
  return env;
}
