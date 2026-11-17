/**
 * api/profiles — named config profiles.  [WP7 1.5]
 *
 * Owns: no state (`routes/config-profiles.ts`, `routes/calibration-profiles.ts` do). Must not
 * know about: `server/*`, `api-server.ts`. Contract: `http.txt` (switch 403/409, the H8 viewer
 * 403s on create/rename/delete), `__tests__/config-profile-create-calibration.test.ts` (drives
 * `createAPIHandler`); the `setImmediate` deferral at switch is H1's ordering vitest
 * (`res.writableEnded`, D72). Kept verbatim: `GET /api/config/profiles` calls `ensureSeeded()`
 * (a GET that may write, D-API2). Import-time effects: none.
 */

import { IncomingMessage, ServerResponse } from 'http';
import {
  listProfiles, switchProfile, createProfile, renameProfile, deleteProfile,
  getActiveProfileName, ensureSeeded, undeployedChanges,
} from '../routes/config-profiles.js';
import {
  listCalibrationProfiles,
  createCalibrationProfile,
  removeCalibrationProfile,
} from '../routes/calibration-profiles.js';
import { sessionManager } from '../session-manager.js';
import { isConfigWriteAuthorized, readJsonBody } from './http.js';
import type { APIHandlerOptions } from './http.js';

export async function handleProfilesRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  const { onConfigUpdated } = opts;
  if (url.pathname === '/api/config/profiles' && req.method === 'GET') {
    // List profiles + which is active + whether a session freezes deploys/switching.
    ensureSeeded();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      profiles: listProfiles(),
      active: getActiveProfileName(),
      sessionActive: sessionManager.getStatus().active,
      // Which profile files differ from what is deployed, so the editor can say how much is
      // waiting rather than just that the config is frozen.
      undeployed: undeployedChanges(),
    }));
    return true;
  }
  if (url.pathname === '/api/config/profiles/switch' && req.method === 'POST') {
    // Switch the active profile and deploy it. Operators only; blocked while a session runs.
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    try {
      const { name } = await readJsonBody(req);
      if (sessionManager.getStatus().active) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cannot switch config while a session is running' }));
        return true;
      }
      switchProfile(name);
      if (onConfigUpdated) setImmediate(() => { try { onConfigUpdated(); } catch (e) { console.warn('⚠️ onConfigUpdated threw:', e); } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, active: getActiveProfileName() }));
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message || 'Failed to switch profile' }));
    }
    return true;
  }
  if (url.pathname === '/api/config/profiles/create' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    try {
      const { name, from, calibration } = await readJsonBody(req);
      // A new config gets a calibration profile of the same name beside it: a copy of an
      // existing calibration profile ({ from: "<name>" }) or a fresh blank one ({}). It is
      // written first because it is the step that can refuse (name taken, source missing),
      // and removed again if the config itself then fails, so neither is left half-made.
      // The live calibration store and the loaded calibration profile are not touched.
      const withCal = calibration && typeof calibration === 'object';
      if (withCal) {
        const calFrom = calibration.from ? String(calibration.from) : undefined;
        createCalibrationProfile(String(name ?? ''), calFrom);
      }
      try {
        createProfile(name, from);
      } catch (e) {
        if (withCal) removeCalibrationProfile(String(name));
        throw e;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, profiles: listProfiles(), calibration_profiles: listCalibrationProfiles() }));
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message || 'Failed to create profile' }));
    }
    return true;
  }
  if (url.pathname === '/api/config/profiles/rename' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    try {
      const { name, newName } = await readJsonBody(req);
      renameProfile(name, newName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, profiles: listProfiles(), active: getActiveProfileName() }));
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message || 'Failed to rename profile' }));
    }
    return true;
  }
  if (url.pathname === '/api/config/profiles/delete' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    try {
      const { name } = await readJsonBody(req);
      deleteProfile(name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, profiles: listProfiles() }));
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error?.message || 'Failed to delete profile' }));
    }
    return true;
  }
  return false;
}
