/**
 * HTTP API server for config management
 * Runs alongside WebSocket server
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readConfig, writeConfig } from './routes/config.js';

const API_PORT = parseInt(process.env.API_PORT || '8082', 10);

export function startAPIServer(): void {
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
