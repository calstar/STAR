/**
 * api/feed-char — feed-characterization results stored with the run.  [WP7 1.11]
 *
 * Owns: nothing; the file lives in the session's `dbDir`. The one method-agnostic path (still an
 * exact pathname, so WP7-S1's disjointness holds). Must not know about: `server/*`,
 * `api-server.ts`. Contract: `http.txt` (409 with no session on any method, GET, POST 200 in mock
 * mode — the run directory exists since C5-2; the H8 viewer 403 during a session). Import-time effects: none.
 */

import * as fs from 'fs';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { sessionManager } from '../session-manager.js';
import { isConfigWriteAuthorized, readJsonBody } from './http.js';
import type { APIHandlerOptions } from './http.js';

export async function handleFeedCharRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  if (url.pathname === '/api/feed-char/results') {
    /**
     * Feed-characterization results, stored WITH the run rather than in the browser.
     *
     * A CdA is a measurement of the rig, derived from that run's telemetry, so it belongs
     * beside that run's data — not in a browser tab that loses it on refresh, nor in a
     * downloaded CSV divorced from the trace it came from. One JSON line per result, in the
     * session's own directory, so a run's folder carries both the raw pressures and what was
     * concluded from them.
     */
    const dbDir = sessionManager.getStatus().dbDir;
    if (!dbDir) {
      // No run to attach to. Say so plainly rather than inventing a location — a result with
      // no run is not a result anyone can check later.
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No active session — start a run before recording results', results: [] }));
      return true;
    }
    const resultsPath = path.join(dbDir, 'feed_characterization.jsonl');

    if (req.method === 'GET') {
      let results: unknown[] = [];
      try {
        results = fs.readFileSync(resultsPath, 'utf-8')
          .split('\n')
          .filter((l) => l.trim())
          // Skip a torn last line rather than failing the whole read: the file is appended to
          // live, so a reader can arrive mid-write.
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((x) => x !== null);
      } catch { /* nothing recorded yet */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results, dbDir }));
      return true;
    }

    if (req.method === 'POST') {
      if (!isConfigWriteAuthorized(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not an approved operator' }));
        return true;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected a result object' }));
        return true;
      }
      // Append, never rewrite: a result already written is a record of something that happened.
      fs.appendFileSync(resultsPath, JSON.stringify({ ...body, recordedAt: new Date().toISOString() }) + '\n', 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: resultsPath }));
      return true;
    }

    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'GET or POST' }));
    return true;
  }
  return false;
}
