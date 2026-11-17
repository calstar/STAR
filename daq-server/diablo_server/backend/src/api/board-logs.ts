/**
 * api/board-logs — board diagnostic logs and their verbosity.  [WP7 1.8]
 *
 * Owns: nothing (`board-logs.ts` owns the ring and the counters). Must not know about: `server/*`,
 * `api-server.ts`. Contract: `http.txt` (P9 schema, the 403), `test/ws_data_flow_test.ts`
 * `testBoardLogMode`. `POST /api/board-log-mode` writes `config.toml` and the active profile
 * through `patchBoardField`, even during a session, and fires no callback
 * (`config_broadcast_service` re-reads the file). Import-time effects: none.
 */

import { IncomingMessage, ServerResponse } from 'http';
import { patchBoardField } from '../routes/config.js';
import { getBoardLogHistory, getBoardLogStats } from '../board-logs.js';
import { isConfigWriteAuthorized } from './http.js';
import type { APIHandlerOptions } from './http.js';

export async function handleBoardLogsRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  if (url.pathname === '/api/board-logs' && req.method === 'GET') {
    // Recent cached board diagnostic logs (in-memory, session-scoped).
    // Optional ?board=<id> and ?limit=<n>. Lets a freshly-opened GUI backfill.
    const boardRaw = url.searchParams.get('board');
    const limitRaw = url.searchParams.get('limit');
    const board = boardRaw !== null ? Number(boardRaw) : undefined;
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;
    const history = getBoardLogHistory({
      board: board !== undefined && Number.isFinite(board) ? board : undefined,
      limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(history));
    return true;
  }
  if (url.pathname === '/api/board-logs/stats' && req.method === 'GET') {
    // Cumulative per-board log counters { boardId: { received, truncated } }.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats: getBoardLogStats() }));
    return true;
  }
  if (url.pathname === '/api/board-log-mode' && req.method === 'POST') {
    // Set one board's logging/serial-print mode byte (0..3) via a surgical single-field edit.
    // Operators only. config_broadcast_service re-reads config.toml and sends the board the
    // new byte on its next cycle.
    //
    // This is the deliberate exception to "config applies at session start": verbosity is
    // turned up because something is misbehaving *now*. patchBoardField also writes the active
    // profile so the setting is not reverted by the next deploy.
    if (!isConfigWriteAuthorized(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not an approved operator' }));
      return true;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const { boardId, mode } = JSON.parse(body || '{}');
        const bid = Number(boardId);
        const m = Number(mode);
        if (!Number.isInteger(bid) || bid <= 0) throw new Error('Invalid boardId');
        if (!Number.isInteger(m) || m < 0 || m > 3) throw new Error('mode must be an integer 0..3');
        patchBoardField(bid, 'enable_serial_printing', m);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, boardId: bid, mode: m }));
      } catch (error: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Failed to set log mode' }));
      }
    });
    return true;
  }
  return false;
}
