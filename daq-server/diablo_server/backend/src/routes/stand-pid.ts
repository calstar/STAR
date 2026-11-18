/**
 * The stand's P&ID for the Schematic page: `stand_pid.json`, beside config.toml.
 *
 * Exported from feed-twin's P&ID tab ("Export for DAQ") and committed here, so
 * the page needs neither feed-twin nor pid-designer running on the stand. The
 * server only hands the file over; the page checks its format and its names.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';

export const STAND_PID_FILE = 'stand_pid.json';

export interface StandPidAnswer {
  status: number;
  body: string;
}

/** The bundle from `configDir`, or a 404 that says how to make one. */
export function readStandPid(configDir: string): StandPidAnswer {
  const path = join(configDir, STAND_PID_FILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return {
      status: 404,
      body: JSON.stringify({
        error: `No ${STAND_PID_FILE} in ${configDir}. Export it from feed-twin's P&ID tab ("Export for DAQ") and commit it beside config.toml.`,
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
