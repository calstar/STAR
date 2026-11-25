/**
 * api/calibration — calibration as files and live state: status, cubic store, ball-valve
 * endpoints, LC tares, calibration profiles.  [WP7 1.10]
 *
 * `GET /api/cubic_calibration` reads routes/calibration-profiles.livePath(). Stores belong to
 * `routes/calibration-profiles.ts`, `ball-valve-cal.ts`, `lc-tare.ts` and `calibration_service` (sole writer of the cubic store). Must not know about: `server/*`
 * (Elodin cmd 7 is reached through `opts.onCalibrationReload`, synchronously, before the
 * response), `api-server.ts`. Contract: `http.txt` (the cubic body, the 403s on save /
 * ball_valve_cal, the H8 viewer 403s on load / new_blank), `boards/http.txt`. Kept verbatim:
 * `/api/calibration_status` always answers the error object (D-API1); bad JSON on the
 * `readJsonBody` routes is a 500 through the router (D-API2). Import-time effects: none.
 */

import * as fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import {
  listCalibrationProfiles,
  saveCalibrationProfile,
  loadCalibrationProfile,
  newBlankCalibration,
  livePath,
} from '../routes/calibration-profiles.js';
import { currentTares } from '../lc-tare.js';
import { captureEndpoint, clearEndpoints, valveCalibrationSnapshot } from '../ball-valve-cal.js';
import { clearCurrents, currentsSnapshot, endTrial, saveTrialAs, setCurrents, startTrial } from '../ball-valve-current.js';
import { isConfigWriteAuthorized, readJsonBody } from './http.js';
import type { APIHandlerOptions } from './http.js';

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
    // sole writer; it rewrites the file atomically per capture). The path is livePath(), the one
    // every other calibration route uses, so DAQ_CALIBRATIONS_DIR is honoured here too (C5-5).
    let body: string | null = null;
    try {
      const live = livePath();
      if (fs.existsSync(live)) body = fs.readFileSync(live, 'utf8');
    } catch { /* unreadable: answered as empty below */ }
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
  if (url.pathname === '/api/ball_valve_current' && req.method === 'GET') {
    // Each ball valve channel's closed/open command current (unlisted: 4 / 20 mA).
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(currentsSnapshot()));
    return true;
  }
  if (url.pathname === '/api/ball_valve_current' && req.method === 'POST') {
    // { entity: "BV1_Cal.CH1", closed_ma: 4.1, open_ma: 19.6 } | { entity, action: "clear" }
    // Moves hardware: config_broadcast sends it within one interval and the board applies it
    // at once, to a valve sitting in that state too. Operators only.
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    //   { entity, action: "trial", ma }          drive the valve at ma now (trial)
    //   { entity, action: "end_trial" }          back to its commanded state's current
    //   { entity, action: "save", as: "open" | "closed" }  the trial becomes that state's current
    //   { entity, action: "clear" }              back to 4 / 20, trial ended
    //   { entity, closed_ma, open_ma }           set both directly
    const body = await readJsonBody(req);
    const entity = String(body?.entity ?? '');
    const action = body?.action;
    let r: { ok: true } | { ok: false; error: string };
    if (action === 'clear') { clearCurrents(entity); r = { ok: true }; }
    else if (action === 'trial') r = startTrial(entity, Number(body?.ma));
    else if (action === 'end_trial') { endTrial(entity); r = { ok: true }; }
    else if (action === 'save') {
      r = body?.as === 'open' || body?.as === 'closed'
        ? saveTrialAs(entity, body.as)
        : { ok: false, error: 'as must be open or closed' };
    } else if (action === undefined) r = setCurrents(entity, Number(body?.closed_ma), Number(body?.open_ma));
    else r = { ok: false, error: 'action must be trial, end_trial, save or clear' };
    res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.ok ? currentsSnapshot() : { error: r.error }));
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
