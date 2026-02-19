/**
 * HTTP API server for config management and Elodin DB queries
 * Runs alongside WebSocket server
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readConfig, writeConfig } from './routes/config.js';
import { ElodinQueryClient, QueryOptions } from './elodin-query.js';
import type { SensorUpdate } from '../../shared/types.js';

const API_PORT = parseInt(process.env.API_PORT || '8082', 10);

export function startAPIServer(getQueryClient?: () => ElodinQueryClient | null): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    try {
      if (url.pathname === '/api/config' && req.method === 'GET') {
        // Read config
        const config = readConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ config }));
      } else if (url.pathname === '/api/config' && req.method === 'POST') {
        // Write config
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const { config } = JSON.parse(body);
            writeConfig(config);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (error: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          }
        });
      } else if (url.pathname === '/api/query' && req.method === 'GET') {
        // Query historical data from Elodin DB
        const currentQueryClient = getQueryClient ? getQueryClient() : null;
        if (!currentQueryClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Query client not available' }));
          return;
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
      } else if (url.pathname === '/api/sensors' && req.method === 'GET') {
        // List all available sensors (subscribed packet IDs)
        const currentQueryClient = getQueryClient ? getQueryClient() : null;
        if (!currentQueryClient) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Query client not available' }));
          return;
        }

        const packetIds = currentQueryClient.getSubscribedPacketIds();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sensors: packetIds.map(([high, low]) => ({
          packet_id: [high, low],
          packet_id_hex: `0x${high.toString(16).padStart(2, '0')},0x${low.toString(16).padStart(2, '0')}`,
        })) }));
      } else if (url.pathname.startsWith('/api/sensors/') && req.method === 'GET') {
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
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (error: any) {
      console.error('API error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  // Register error handler BEFORE calling listen()
  server.on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') {
      console.warn(`⚠️ Port ${API_PORT} already in use. API server will not start.`);
      console.warn(`   This is OK if another instance is running.`);
    } else {
      console.error('❌ API server error:', error);
    }
  });

  server.listen(API_PORT, () => {
    console.log(`📡 API server listening on port ${API_PORT}`);
  });
}
