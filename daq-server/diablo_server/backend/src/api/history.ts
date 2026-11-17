/**
 * api/history — Elodin historical queries; all three depend on `opts.getQueryClient`, which
 * `server.ts` never passes (D-API1, kept; removing the option is Parked).  [WP7 1.6]
 *
 * Owns: nothing. Must not know about: `server/*`, `api-server.ts`. `ElodinQueryClient` and
 * `QueryOptions` are type-only imports here as in `api-server.ts` today: elided at runtime, and
 * they must **not** become a bare import (that would add `elodin-query.ts` to the evaluation set,
 * WP7-S2c). Contract: `http.txt` (the 503 `Query client not available` on `/api/query` and
 * `/api/sensors`, the `/api/sensors/<entity>` placeholder). Import-time effects: none.
 */

import { IncomingMessage, ServerResponse } from 'http';
import type { ElodinQueryClient, QueryOptions } from '../elodin-query.js';
import type { APIHandlerOptions } from './http.js';

export async function handleHistoryRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  const { getQueryClient } = opts;
  if (url.pathname === '/api/query' && req.method === 'GET') {
    // Query historical data from Elodin DB
    const currentQueryClient = getQueryClient ? getQueryClient() : null;
    if (!currentQueryClient) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query client not available' }));
      return true;
    }

    const packetIdHigh = parseInt(url.searchParams.get('packet_id_high') || '0x20', 16);
    const packetIdLow = parseInt(url.searchParams.get('packet_id_low') || '0x11', 16);
    const startTime = url.searchParams.get('start_time') ? parseInt(url.searchParams.get('start_time')!) : undefined;
    const endTime = url.searchParams.get('end_time') ? parseInt(url.searchParams.get('end_time')!) : undefined;
    const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!) : 1000;

    const queryOptions: QueryOptions = {
      packetId: [packetIdHigh, packetIdLow],
      startTime,
      endTime,
      limit,
    };

    currentQueryClient.query(queryOptions)
      .then((response) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      })
      .catch((error: any) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      });
    return true;
  }
  if (url.pathname === '/api/sensors' && req.method === 'GET') {
    // List all available sensors (subscribed packet IDs)
    const currentQueryClient = getQueryClient ? getQueryClient() : null;
    if (!currentQueryClient) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Query client not available' }));
      return true;
    }

    const packetIds = currentQueryClient.getSubscribedPacketIds();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sensors: packetIds.map(([high, low]) => ({
        packet_id: [high, low],
        packet_id_hex: `0x${high.toString(16).padStart(2, '0')},0x${low.toString(16).padStart(2, '0')}`,
      }))
    }));
    return true;
  }
  if (url.pathname.startsWith('/api/sensors/') && req.method === 'GET') {
    // Get latest value for a specific entity
    // Format: /api/sensors/PT_Cal.PT_CH1
    const entity = url.pathname.replace('/api/sensors/', '');

    // This would require access to sensor cache from server
    // For now, return a placeholder
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      entity,
      message: 'Use WebSocket for real-time data. Historical queries via /api/query',
    }));
    return true;
  }
  return false;
}
