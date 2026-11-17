/**
 * api/calibration — calibration as files and live state: status, cubic store, ball-valve
 * endpoints, LC tares, calibration profiles.  [WP7 1.10]
 *
 * Owns: the module constant `SRC_DIR` (from `import.meta.url`, STYLE-S30; WP7-S3): the two
 * `__dirname` candidates of `GET /api/cubic_calibration` are re-rooted on it so this one-level-
 * deeper file resolves the same paths `api-server.ts` did — step 1's only non-verbatim edit.
 * Stores belong to `routes/calibration-profiles.ts`, `ball-valve-cal.ts`, `lc-tare.ts` and
 * `calibration_service` (sole writer of the cubic store). Must not know about: `server/*`
 * (Elodin cmd 7 is reached through `opts.onCalibrationReload`, synchronously, before the
 * response), `api-server.ts`. Contract: `http.txt` (the cubic body, the 403s on save /
 * ball_valve_cal, the H8 viewer 403s on load / new_blank), `boards/http.txt`. Kept verbatim:
 * `/api/calibration_status` always answers the error object (D-API1); bad JSON on the
 * `readJsonBody` routes is a 500 through the router (D-API2); `cubic_calibration` ignores
 * `DAQ_CALIBRATIONS_DIR` (C5-5). Import-time effects: none.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { IncomingMessage, ServerResponse } from 'http';
import {
  listCalibrationProfiles,
  saveCalibrationProfile,
  loadCalibrationProfile,
  newBlankCalibration,
} from '../routes/calibration-profiles.js';
import { currentTares } from '../lc-tare.js';
import { captureEndpoint, clearEndpoints, valveCalibrationSnapshot } from '../ball-valve-cal.js';
import { isConfigWriteAuthorized, readJsonBody } from './http.js';
import type { APIHandlerOptions } from './http.js';

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function handleCalibrationRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  const { getCalibrationStatus, onCalibrationReload } = opts;
  if (url.pathname === '/api/calibration_status' && req.method === 'GET') {
    const status = getCalibrationStatus ? await getCalibrationStatus() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status ?? { error: 'Calibration status not available' }));
    return true;
  }
  if (url.pathname === '/api/cubic_calibration' && req.method === 'GET') {
    // Read-only view of the calibration service's cubic_calibration.json (the service is the
    // sole writer; it rewrites the file atomically per capture). Search the same candidate
    // roots loadPTCalibration() uses, covering both dev (tsx) and dist layouts.
    const candidates = [
      path.join(SRC_DIR, '../../../scripts/calibration/calibrations/cubic_calibration.json'),
      path.join(SRC_DIR, '../../../../scripts/calibration/calibrations/cubic_calibration.json'),
      path.join(process.cwd(), 'scripts/calibration/calibrations/cubic_calibration.json'),
      path.join(process.cwd(), '../../scripts/calibration/calibrations/cubic_calibration.json'),
    ];
    let body: string | null = null;
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) { body = fs.readFileSync(c, 'utf8'); break; }
      } catch { /* try next candidate */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (body == null) {
      res.end(JSON.stringify({ cubic_state: {} }));
    } else {
      try { JSON.parse(body); res.end(body); }
      catch { res.end(JSON.stringify({ cubic_state: {} })); }  // partial/corrupt → empty
    }
    return true;
  }
  if (url.pathname === '/api/ball_valve_cal' && req.method === 'GET') {
    // Each ball valve channel's stored closed/open endpoints and its live reading.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ valves: valveCalibrationSnapshot() }));
    return true;
  }
  if (url.pathname === '/api/ball_valve_cal' && req.method === 'POST') {
    // { entity: "BV1_Cal.CH1", action: "closed" | "open" | "clear" }
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    const body = await readJsonBody(req);
    const entity = String(body?.entity ?? '');
    const action = String(body?.action ?? '');
    if (action === 'clear') {
      clearEndpoints(entity);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valves: valveCalibrationSnapshot() }));
    } else if (action === 'closed' || action === 'open') {
      const r = captureEndpoint(entity, action);
      res.writeHead(r.ok ? 200 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.ok ? { valves: valveCalibrationSnapshot() } : { error: r.error }));
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'action must be closed, open or clear' }));
    }
    return true;
  }
  if (url.pathname === '/api/lc_tare' && req.method === 'GET') {
    // The live load-cell tares, for the UI to badge tared channels and show their offsets.
    //
    // Read from the same file the stream subtraction uses, so the badge and the number on
    // the plot can never disagree. This is the authoritative source for tare UI state — do
    // NOT let the page assume a tare landed because it sent the command; [0x46,0x00] carries
    // no reply, so only the file says whether the service accepted it.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    try {
      res.end(JSON.stringify({ tares: currentTares() }));
    } catch {
      res.end(JSON.stringify({ tares: [] }));
    }
    return true;
  }
  if (url.pathname === '/api/calibration_profiles' && req.method === 'GET') {
    // List committed whole-rig calibration snapshots + which one is loaded.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listCalibrationProfiles()));
    return true;
  }
  if (url.pathname === '/api/calibration_profiles/save' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    const body = await readJsonBody(req);
    saveCalibrationProfile(String(body?.name ?? ''));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listCalibrationProfiles()));
    return true;
  }
  if (url.pathname === '/api/calibration_profiles/load' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    const body = await readJsonBody(req);
    loadCalibrationProfile(String(body?.name ?? ''));
    if (onCalibrationReload) onCalibrationReload();  // service re-reads the swapped live store
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listCalibrationProfiles()));
    return true;
  }
  if (url.pathname === '/api/calibration_profiles/new_blank' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    const body = await readJsonBody(req);
    const name = body?.name ? String(body.name) : undefined;
    newBlankCalibration(name);
    if (onCalibrationReload) onCalibrationReload();  // service re-reads the blank live store
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listCalibrationProfiles()));
    return true;
  }
  return false;
}
