/**
 * api/gui-config — the deployed config as the GUI lays it out.  [WP7 1.7]
 *
 * Owns: nothing. Must not know about: `server/*`, `api-server.ts`, the editor's draft (it reads
 * the **deployed** config, unlike `api/states`; frozen). Contract: `pipeline/golden/http.txt`,
 * `boards/http.txt` (`/api/sensor-config` for every board type), `__tests__/t7.test.ts` (through
 * the `api-server.ts` re-export of `buildSensorConfig`). Import-time effects: none.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { readDeployedConfig } from '../routes/config.js';
import { buildSensorConfig } from '../sensor-config.js';
import type { APIHandlerOptions } from './http.js';

export async function handleGuiConfigRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  if (url.pathname === '/api/pressure-limits' && req.method === 'GET') {
    // Return pressure limits from config.toml (NOP, MEOP, POP per fluid system).
    // Cached until the next deploy — config cannot change during a session.
    const config = readDeployedConfig();
    const limits = config.pressure_limits || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pressure_limits: limits }));
    return true;
  }
  if (url.pathname === '/api/gui-config' && req.method === 'GET') {
    // GUI-driven config lists from config.toml [gui]: the ordered top-bar pressure gauges
    // ([[gui.pressure_bars]]) and the tab-bar tabs+order (gui.tabs). Bar NOP/MEOP come from
    // [pressure_limits]; tab ids index the frontend view catalog.
    //
    // Served from the deployed-config cache, not re-read per request. GUI config is frozen
    // during a session like everything else; the browser is told to refetch by the
    // CONFIG_UPDATED broadcast when a deploy actually happens.
    const config = readDeployedConfig();
    const gui = config.gui ?? {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      pressure_bars: gui.pressure_bars ?? [],
      tabs: gui.tabs ?? [],
      // [gui.groups]: page name → ordered role-name list (explicit sensor→page membership).
      groups: gui.groups ?? {},
      // The state diagram's grid size (frontend lib/panel-layout.ts); absent = fit the states.
      state_grid_rows: gui.state_grid_rows,
      state_grid_cols: gui.state_grid_cols,
    }));
    return true;
  }
  if (url.pathname === '/api/sensor-config' && req.method === 'GET') {
    // Return sensor configuration derived from config.toml:
    // role names, board assignments, entity strings, calibration flags
    const sensorConfig = buildSensorConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sensors: sensorConfig }));
    return true;
  }
  return false;
}
