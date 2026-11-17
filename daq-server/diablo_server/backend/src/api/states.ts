/**
 * api/states — the state machine as files: state list, state CSVs, dynamic-state scripts.
 * [WP7 1.4]
 *
 * Owns: no state. Reads and writes through `routes/config-profiles.ts` (a CSV reader separate
 * from `state-csv/*`, by design); scripts are checked by `routes/script-check.ts`. Must not know
 * about: `server/*` (the rebuilt actuator map is `server.ts`'s, via `opts.onStateCsvUpdated`),
 * `api-server.ts`. Contract: `pipeline/golden/csv.txt`, `http.txt`; H1/H8; the `setImmediate`
 * deferral of `onStateCsvUpdated` is H1's ordering vitest (`res.writableEnded`, D72). Kept
 * verbatim: `GET /api/state-script?name=<missing>` → 200 with an empty body (C5-6);
 * `POST /api/state-script/check` ungated, unbounded body, a process per call (SEC-9).
 * Import-time effects: none.
 */

import { IncomingMessage, ServerResponse } from 'http';
import {
  readActiveProfile, readStateCsv, writeStateCsv, isStateCsvName, STATE_CSVS,
  readStateScript, writeStateScript, listStateScripts,
} from '../routes/config-profiles.js';
import { checkStateScript } from '../routes/script-check.js';
import { sessionManager } from '../session-manager.js';
import { isConfigWriteAuthorized } from './http.js';
import type { APIHandlerOptions } from './http.js';

export async function handleStatesRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  const { onStateCsvUpdated } = opts;
  if (url.pathname === '/api/states' && req.method === 'GET') {
    // The state list from the active profile's [[states]]. One source for the labels the GUI
    // used to keep in six separate maps, several of which had drifted — the top bar rendered
    // ids 18 and 19 as "STATE 18"/"STATE 19" because they were simply missing from its copy.
    try {
      const cfg = readActiveProfile();
      const raw = Array.isArray((cfg as any)?.states) ? (cfg as any).states : [];
      // Which state is the burn is [fire].state, a name — the GUI used to answer this with
      // `currentState === SystemState.FIRE`, a literal 16, so on a rig whose Fire is any other
      // id the Extend Fire button stayed disabled through the burn and the PWM page refused to
      // send. Carry it beside isAbort so the client never has to know an id.
      const fireStateName = typeof (cfg as any)?.fire?.state === 'string' ? (cfg as any).fire.state : null;
      const states = raw
        .filter((e: any) => typeof e?.id === 'number' && typeof e?.name === 'string')
        .map((e: any) => ({
          id: e.id,
          name: e.name,
          isAbort: e.is_abort === true,
          isBoot: e.is_boot === true,
          isFire: fireStateName !== null && e.name === fireStateName,
          // Which state the characterization hold drives. A flag, not a name — the operator
          // may rename or move it and every client follows without a code change.
          isFlow: e.is_flow === true,
          // A non-empty script_file is what makes a state dynamic — there is no separate flag
          // that could disagree with it. The panel needs this because a dynamic state is not a
          // latch: it runs, and it leaves on its own, so leaving it is a different gesture.
          //
          // The script TEXT is deliberately not here. The control page has no use for it, and
          // the config editor reads it from /api/state-script.
          isDynamic: typeof e.script_file === 'string' && e.script_file.trim() !== '',
          scriptTimeoutMs: typeof e.script_timeout_ms === 'number' ? e.script_timeout_ms : null,
          scriptReturnTarget:
            typeof e.script_return_target === 'string' ? e.script_return_target : null,
          scriptTimeoutTarget:
            typeof e.script_timeout_target === 'string' ? e.script_timeout_target : null,
          // Absent coordinates mean "not on the control panel" — no separate hidden flag.
          panelRow: typeof e.panel_row === 'number' ? e.panel_row : null,
          panelCol: typeof e.panel_col === 'number' ? e.panel_col : null,
        }));
      // [flow] rides along so a client can seed and bound a duration input without a second
      // request. null when the stand has no flow hold configured, which is the client's cue to
      // disable the control rather than offer one that the sequencer will refuse.
      const rawFlow = (cfg as any)?.flow;
      const flow = rawFlow && typeof rawFlow.return_target === 'string' && rawFlow.return_target
        ? {
          returnTarget: rawFlow.return_target as string,
          durationMs: typeof rawFlow.duration_ms === 'number' ? rawFlow.duration_ms : null,
          maxMs: typeof rawFlow.max_ms === 'number' ? rawFlow.max_ms : null,
        }
        : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ states, flow }));
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'Failed to read states' }));
    }
    return true;
  }
  if (url.pathname === '/api/state-csv' && req.method === 'GET') {
    // Raw state-machine CSV from the ACTIVE PROFILE. Read-only — no operator gate, matching
    // /api/config/export.
    try {
      const which = String(url.searchParams.get('name') || '');
      if (!isStateCsvName(which)) throw new Error(`Unknown CSV "${which}"`);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${STATE_CSVS[which]}"`,
      });
      res.end(readStateCsv(which));
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'Failed to read CSV' }));
    }
    return true;
  }
  if (url.pathname === '/api/state-csv' && req.method === 'POST') {
    // Write a state CSV into the active profile; deploy when idle (same freeze rule as a
    // config save — during a session it stays a draft applied at the next start).
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const which = String(url.searchParams.get('name') || '');
        if (!isStateCsvName(which)) throw new Error(`Unknown CSV "${which}"`);
        if (!body.trim()) throw new Error('CSV is empty');
        // A header row plus at least one data row; anything less is a truncated upload, and a
        // CSV that parses to nothing silently disables every actuator for every state.
        const rows = body.split('\n').map((l) => l.trim()).filter(Boolean);
        if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');
        const sessionActive = sessionManager.getStatus().active;
        const deployed = writeStateCsv(which, body, !sessionActive);
        if (deployed && onStateCsvUpdated) {
          setImmediate(() => {
            try { onStateCsvUpdated(); } catch (e) { console.warn('⚠️ onStateCsvUpdated handler threw:', e); }
          });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          deployed,
          message: deployed ? 'Saved and applied' : 'Saved as draft (applies at next session start)',
        }));
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Invalid CSV' }));
      }
    });
    return true;
  }
  if (url.pathname === '/api/state-script' && req.method === 'GET') {
    // One dynamic-state script from the ACTIVE PROFILE, or the list of them. Read-only, so no
    // operator gate — same posture as /api/state-csv and /api/config/export.
    try {
      const which = url.searchParams.get('name');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(which === null
        ? JSON.stringify({ scripts: listStateScripts() })
        : JSON.stringify({ name: which, source: readStateScript(String(which)) }));
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'Failed to read script' }));
    }
    return true;
  }
  if (url.pathname === '/api/state-script' && req.method === 'POST') {
    // Write a script into the active profile; deploy when idle. Same freeze rule as a config
    // save — during a session it stays a draft, applied at the next session start.
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const which = String(url.searchParams.get('name') || '');
        const stateName = String(url.searchParams.get('state') || '');
        if (!stateName) throw new Error('state is required');

        // Syntax-checked before it is written, by the sequencer's own parser. A check that
        // could not run (no build yet) does not block the save — the sequencer re-checks at
        // startup and is the authority either way.
        const check = await checkStateScript(body, stateName);
        if (!check.ok) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Script has errors', diagnostics: check.diagnostics }));
          return;
        }

        const sessionActive = sessionManager.getStatus().active;
        const deployed = writeStateScript(which, body, !sessionActive);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          deployed,
          checked: !check.unavailable,
          message: deployed ? 'Saved and applied' : 'Saved as draft (applies at next session start)',
        }));
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Invalid script' }));
      }
    });
    return true;
  }
  if (url.pathname === '/api/state-script/check' && req.method === 'POST') {
    // Debounced syntax check from the editor, without saving.
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const stateName = String(url.searchParams.get('state') || '');
        if (!stateName) throw new Error('state is required');
        const check = await checkStateScript(body, stateName);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(check));
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Check failed' }));
      }
    });
    return true;
  }
  return false;
}
