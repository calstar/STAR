/**
 * api/debug — diagnostics and the legacy stub.  [WP7 1.9]
 *
 * Owns: nothing; reads WS-side values only through `opts.getDebugInfo` and `opts.getEngineState`.
 * Must not know about: `server/*`, `api-server.ts`. Contract: `http.txt` (P9 schema for
 * `/api/debug`, `/api/engine_state`, the `{"packets": []}` stub). Import-time effects: none.
 */

import { IncomingMessage, ServerResponse } from 'http';
import type { APIHandlerOptions } from './http.js';

export async function handleDebugRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  const { getDebugInfo, getEngineState } = opts;
  if (url.pathname === '/api/debug' && req.method === 'GET') {
    const info = getDebugInfo ? getDebugInfo() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(info ?? { error: 'Debug info not available' }));
    return true;
  }
  if (url.pathname === '/api/engine_state' && req.method === 'GET') {
    const engineState = getEngineState ? getEngineState() : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ engineState }));
    return true;
  }
  if (url.pathname === '/api/config_packets' && req.method === 'GET') {
    // Config packets now built by config_broadcast_service.py (standalone). Return empty.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ packets: [] }));
    return true;
  }
  return false;
}
