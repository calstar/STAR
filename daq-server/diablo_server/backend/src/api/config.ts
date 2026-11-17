/**
 * api/config — the editor's config document: read, save, export, import, validate.  [WP7 1.3]
 *
 * Owns: no state; the active profile and `config.toml` belong to `routes/config-profiles.ts` /
 * `routes/config.ts`. Must not know about: `server/*` (reached only through
 * `opts.onConfigUpdated`), other groups, `api-server.ts`. Callback timing (STYLE-S29): the
 * response is written first, `onConfigUpdated` runs on the next `setImmediate`, and only when no
 * session is active. Contract: `pipeline/golden/http.txt` (GETs, 403s); H1 freezes the write
 * success paths and their `config_updated` / `board_status_update` frames; the deferral itself is
 * H1's ordering vitest (D72): `res.writableEnded === true` inside a mocked `onConfigUpdated` at
 * save and import. Import-time effects: none.
 */

import * as fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import { readConfig, readDeployedConfig, getConfigPath, getRunningConfigPath, validateControllerActuators } from '../routes/config.js';
import {
  getActiveProfileName, readActiveProfile, writeActiveProfile, deployActiveProfile,
  getActiveProfilePath,
} from '../routes/config-profiles.js';
import { sessionManager } from '../session-manager.js';
import { validateActiveProfile } from '../config-validation.js';
import { isConfigWriteAuthorized } from './http.js';
import type { APIHandlerOptions } from './http.js';

export async function handleConfigRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  const { onConfigUpdated } = opts;
  if (url.pathname === '/api/config' && req.method === 'GET') {
    // The editor reads the ACTIVE PROFILE (the draft you edit), not the deployed config.toml.
    const config = readActiveProfile();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config, active: getActiveProfileName() }));
    return true;
  }
  if (url.pathname === '/api/config/running' && req.method === 'GET') {
    // The config the pipeline is reading right now (routes/config.ts getRunningConfigPath):
    // what every page that DISPLAYS the stand reads. /api/config is the editor's draft (the
    // active profile), which differs from it during a session and in every simulated run.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ config: readDeployedConfig(), path: getRunningConfigPath() }));
    return true;
  }
  if (url.pathname === '/api/config' && req.method === 'POST') {
    // Save to the ACTIVE PROFILE. When idle, also deploy it to config.toml (the running file);
    // during a session config.toml is frozen — the write is a draft applied at the next start.
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { config } = JSON.parse(body);
        // The editor refuses to save this, but it is not the only writer — enforce it where
        // every write passes. A dangling PWM actuator means the controller comes up with its
        // fire gate disabled, which is far better found here than at the next restart.
        const pwmIssues = validateControllerActuators(config);
        if (pwmIssues.length > 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid controller PWM actuators: ${pwmIssues.join('; ')}` }));
          return;
        }
        const sessionActive = sessionManager.getStatus().active;
        console.log(`📝 Config save → active profile "${getActiveProfileName()}"${sessionActive ? ' (draft; config.toml frozen — session active)' : ' (+ deploy to config.toml)'}`);
        writeActiveProfile(config);
        if (!sessionActive) {
          deployActiveProfile();
          if (onConfigUpdated) {
            setImmediate(() => {
              try { onConfigUpdated(); } catch (e) { console.warn('⚠️ onConfigUpdated handler threw:', e); }
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deployed: !sessionActive, message: sessionActive ? 'Saved as draft (applies at next session start)' : 'Config saved and deployed' }));
      } catch (error: any) {
        console.error('❌ Config save error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Failed to save config' }));
      }
    });
    return true;
  }
  if (url.pathname === '/api/config/export' && req.method === 'GET') {
    // Raw config.toml download (backup). Read-only — no operator gate.
    try {
      const raw = fs.readFileSync(getConfigPath(), 'utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="config.toml"',
      });
      res.end(raw);
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'Failed to read config' }));
    }
    return true;
  }
  if (url.pathname === '/api/config/import' && req.method === 'POST') {
    // Replace config.toml with an uploaded file (restore). Operators only.
    // Validate by writing then re-reading with the app's tolerant parser;
    // roll back to the previous contents if it fails to parse.
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      // Import replaces the ACTIVE PROFILE (validated), then deploys to config.toml when idle —
      // same freeze rule as a save.
      const target = getActiveProfilePath();
      let previous: string | null = null;
      try {
        if (!body.trim()) throw new Error('Uploaded config is empty');
        previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
        fs.writeFileSync(target, body, 'utf-8');
        const imported = readConfig(target); // throws if the uploaded TOML is invalid
        // Parsing is not the only way an uploaded config can be wrong. Throwing here reuses
        // the rollback below, so a file naming a PWM actuator that doesn't exist never
        // becomes the deployed config.
        const importPwmIssues = validateControllerActuators(imported);
        if (importPwmIssues.length > 0)
          throw new Error(`Invalid controller PWM actuators: ${importPwmIssues.join('; ')}`);
        const sessionActive = sessionManager.getStatus().active;
        if (!sessionActive) {
          deployActiveProfile();
          if (onConfigUpdated) {
            setImmediate(() => {
              try { onConfigUpdated(); } catch (e) { console.warn('⚠️ onConfigUpdated handler threw:', e); }
            });
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deployed: !sessionActive, message: sessionActive ? 'Imported as draft (applies at next session start)' : 'Config imported and deployed' }));
      } catch (error: any) {
        if (previous !== null) {
          try { fs.writeFileSync(target, previous, 'utf-8'); } catch { /* best effort */ }
        }
        console.error('❌ Config import error:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Invalid config file' }));
      }
    });
    return true;
  }
  if (url.pathname === '/api/config/validate' && req.method === 'GET') {
    // What the session-start gate would find, without attempting a start. Read-only, so no
    // operator check — this reports on config the caller can already read via GET /api/config.
    // The gate itself lives in SessionManager.start(); this endpoint never decides anything.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(validateActiveProfile()));
    return true;
  }
  return false;
}
