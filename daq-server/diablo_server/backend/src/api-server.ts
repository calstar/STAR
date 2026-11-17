/**
 * HTTP API routes for config management and Elodin DB queries.
 * Exports a request handler to be mounted on an existing HTTP server.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { IncomingMessage, ServerResponse } from 'http';

// ESM has no __dirname global. tsx injects one in dev, but `node dist/server.js` (the systemd sim)
// does not — so the __dirname candidates below would throw ReferenceError. Define it explicitly.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { readConfig, readDeployedConfig, writeConfig, getConfigPath, getRunningConfigPath, patchBoardField, validateControllerActuators } from './routes/config.js';
import './routes/config-profiles.js';
import './routes/script-check.js';
import {
  listCalibrationProfiles,
  saveCalibrationProfile,
  loadCalibrationProfile,
  createCalibrationProfile,
  removeCalibrationProfile,
  newBlankCalibration,
} from './routes/calibration-profiles.js';
import { buildSensorConfig } from './sensor-config.js';
import './session-manager.js';
import { validateActiveProfile } from './config-validation.js';
import './operators.js';
import './ota-build.js';
import './ota-service-cmd.js';
import { ElodinQueryClient, QueryOptions } from './elodin-query.js';
import './board-logs.js';
import type { SensorUpdate } from './shared-types.js';
import { currentTares } from './lc-tare.js';
import { t7Channels } from '../../shared/config-validation.js';
import { handleVideoRequest } from './video/routes.js';
import type { VideoService } from './video/service.js';
import { captureEndpoint, clearEndpoints, valveCalibrationSnapshot } from './ball-valve-cal.js';
import { isConfigWriteAuthorized, readJsonBody, type APIHandlerOptions } from './api/http.js';
export type { APIHandlerOptions, BoardScanRateHz, DebugInfo } from './api/http.js';
export { buildSensorConfig, type SensorConfigEntry } from './sensor-config.js';
import { handleConfigRequest } from './api/config.js';
import { handleStatesRequest } from './api/states.js';
import { handleProfilesRequest } from './api/profiles.js';
import { handleHistoryRequest } from './api/history.js';
import { handleGuiConfigRequest } from './api/gui-config.js';
import { handleBoardLogsRequest } from './api/board-logs.js';
import { handleDebugRequest } from './api/debug.js';
import { handleCalibrationRequest } from './api/calibration.js';
import { handleFeedCharRequest } from './api/feed-char.js';
import { handleOtaRequest } from './api/ota.js';

/**
 * Create an HTTP request handler for all /api/* routes.
 * Mount this on an existing http.Server — it does NOT create its own server.
 * Returns true if the request was handled, false if not (so the caller can fall through).
 */
export function createAPIHandler(opts: APIHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { getQueryClient, getDebugInfo, onConfigUpdated, onStateCsvUpdated, getEngineState, getCalibrationStatus, onCalibrationReload, video } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const urlPath = (req.url ?? '').split('?')[0] ?? '';
    if (!urlPath.startsWith('/api/')) return false;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
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
      if (await handleHistoryRequest(req, res, url, opts)) return true;
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
