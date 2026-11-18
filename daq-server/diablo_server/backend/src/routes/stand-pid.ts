/**
 * The stand's P&ID for the Schematic page: `stand_pid.json`, beside config.toml.
 *
 * Exported from feed-twin's P&ID tab ("Export for DAQ") and committed here, so
 * the page needs neither feed-twin nor pid-designer running on the stand. The
 * server only hands the file over; the page checks its format and its names.
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';

export const STAND_PID_FILE = 'stand_pid.json';

export interface StandPidAnswer {
  status: number;
  body: string;
}

/**
 * The bundle from the first of `configDirs` that has one, or a 404 that says
 * how to make one.
 *
 * Several, because the config being read is not always the checkout's: a sim
 * run reads a config generated under /tmp, but the stand's drawing is the one
 * committed in the checkout's config/ either way.
 */
export function readStandPid(...configDirs: string[]): StandPidAnswer {
  let path = '';
  let text: string | null = null;
  for (const dir of configDirs) {
    path = join(dir, STAND_PID_FILE);
    try {
      text = readFileSync(path, 'utf-8');
      break;
    } catch {
      // next
    }
  }
  if (text === null) {
    return {
      status: 404,
      body: JSON.stringify({
        error: `No ${STAND_PID_FILE} in ${configDirs.join(' or ')}. Export it from feed-twin's P&ID tab ("Export for DAQ") and commit it beside config.toml.`,
      }),
    };
  }
  try {
    JSON.parse(text);
  } catch (e) {
    return {
      status: 500,
      body: JSON.stringify({ error: `${path} is not JSON: ${e instanceof Error ? e.message : String(e)}` }),
    };
  }
  return { status: 200, body: text };
}

/** Where the bundle lives: the directory config.toml is read from. */
export const standPidDir = (configPath: string) => dirname(configPath);

/**
 * The checkout's own config/: the nearest one above `here` that holds
 * config_base.toml. Walked up to rather than counted, because the compiled
 * backend sits deeper (dist/backend/src/...) than its source.
 */
export function checkoutConfigDir(here: string): string {
  let dir = here;
  for (;;) {
    const config = join(dir, 'config');
    if (existsSync(join(config, 'config_base.toml'))) return config;
    const up = dirname(dir);
    if (up === dir) return join(here, 'config');
    dir = up;
  }
}
