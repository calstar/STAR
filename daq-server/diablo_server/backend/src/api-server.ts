/**
 * HTTP API routes for config management and Elodin DB queries.
 * Exports a request handler to be mounted on an existing HTTP server.
 */

import { IncomingMessage, ServerResponse } from 'http';

import './routes/config-profiles.js';
import './routes/script-check.js';
import './session-manager.js';
import './operators.js';
import './ota-build.js';
import './ota-service-cmd.js';
import './board-logs.js';
import { handleVideoRequest } from './video/routes.js';
import type { APIHandlerOptions } from './api/http.js';
export type { APIHandlerOptions, BoardScanRateHz, DebugInfo } from './api/http.js';
export { buildSensorConfig, type SensorConfigEntry } from './sensor-config.js';
import { handleConfigRequest } from './api/config.js';
import { handleStatesRequest } from './api/states.js';
import { handleProfilesRequest } from './api/profiles.js';
import { handleGuiConfigRequest } from './api/gui-config.js';
import { handleBoardLogsRequest } from './api/board-logs.js';
import { handleDebugRequest } from './api/debug.js';
import { handleCalibrationRequest } from './api/calibration.js';
import { handleFeedCharRequest } from './api/feed-char.js';
import { handleOtaRequest } from './api/ota.js';
import { isAllowedOrigin } from './origin-policy.js';

/**
 * Create an HTTP request handler for all /api/* routes.
 * Mount this on an existing http.Server — it does NOT create its own server.
 * Returns true if the request was handled, false if not (so the caller can fall through).
 */
export function createAPIHandler(opts: APIHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { getDebugInfo, onConfigUpdated, onStateCsvUpdated, getEngineState, getCalibrationStatus, onCalibrationReload, video } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const urlPath = (req.url ?? '').split('?')[0] ?? '';
    if (!urlPath.startsWith('/api/')) return false;

    // CORS (SEC-6): only the GUI's own origins (origin-policy.ts). A request from any other
    // page is refused before it reaches a route; an allowed one gets its origin echoed back,
    // never `*`. No Origin (a non-browser client, a same-origin GET) gets no Allow-Origin.
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Origin not allowed' }));
      return true;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return true;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    try {
      // Video owns its own sub-tree (video/routes.ts) rather than growing this chain.
      if (video && url.pathname.startsWith('/api/video/')) {
        await handleVideoRequest(req, res, url.pathname, video);
        return true;
      }
      if (await handleConfigRequest(req, res, url, opts)) return true;
      if (await handleStatesRequest(req, res, url, opts)) return true;
      if (await handleProfilesRequest(req, res, url, opts)) return true;
      if (await handleGuiConfigRequest(req, res, url, opts)) return true;
      if (await handleBoardLogsRequest(req, res, url, opts)) return true;
      if (await handleDebugRequest(req, res, url, opts)) return true;
      if (await handleCalibrationRequest(req, res, url, opts)) return true;
      if (await handleFeedCharRequest(req, res, url, opts)) return true;
      if (await handleOtaRequest(req, res, url, opts)) return true;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (error: any) {
      console.error('API error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }

    return true;
  };
}
