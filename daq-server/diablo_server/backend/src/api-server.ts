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
import { sessionManager } from './session-manager.js';
import { validateActiveProfile } from './config-validation.js';
import './operators.js';
import { discoverProjects, getEnabledBoardsForFlash, getOtaWorkspaceRoot, BOARD_TYPE_TO_PROJECT } from './ota-build.js';
import { otaBuildFlash, otaFlashFirmwareFile } from './ota-service-cmd.js';
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
      } else if (url.pathname === '/api/ota-flash/projects' && req.method === 'GET') {
        const projects = discoverProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects }));
      } else if (url.pathname === '/api/ota-flash/flash-all' && req.method === 'POST') {
        const boards = getEnabledBoardsForFlash();
        if (boards.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'No enabled boards in config' }));
          return true;
        }

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const sendSSE = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        sendSSE('progress', { message: `Starting flash-all for ${boards.length} boards (ota_service build+flash)…` });

        const results: Array<{
          key: string;
          type: string;
          ip: string;
          boardId: number;
          success: boolean;
          error?: string;
        }> = [];
        let flashed = 0;
        let failed = 0;
        const root = getOtaWorkspaceRoot();

        for (let i = 0; i < boards.length; i++) {
          const b = boards[i];
          const rel = BOARD_TYPE_TO_PROJECT[b.type];
          if (!rel) {
            const r = { ...b, success: false as const, error: `No firmware project for type ${b.type}` };
            results.push(r);
            sendSSE('board_result', r);
            failed++;
            continue;
          }
          const absProj = path.join(root, rel);
          sendSSE('progress', {
            message: `[${i + 1}/${boards.length}] Build+flash ${b.type} (ID ${b.boardId}) → ${b.ip}…`,
          });
          const { ok, reply } = await otaBuildFlash(b.ip, absProj, b.boardId);
          if (ok) {
            const r = { ...b, success: true as const };
            results.push(r);
            sendSSE('board_result', r);
            flashed++;
          } else {
            const r = { ...b, success: false as const, error: reply };
            results.push(r);
            sendSSE('board_result', r);
            failed++;
          }
        }

        sendSSE('done', {
          success: failed === 0,
          total: boards.length,
          flashed,
          failed,
          results,
        });
        res.end();
      } else if (url.pathname === '/api/ota-flash' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        let totalLen = 0;
        const MAX_BODY = 4 * 1024 * 1024; // 4MB (firmware ~2MB base64)
        req.on('data', (chunk: Buffer) => {
          totalLen += chunk.length;
          if (totalLen <= MAX_BODY) chunks.push(chunk);
        });
        req.on('end', async () => {
          try {
            if (totalLen > MAX_BODY) {
              res.writeHead(413, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Firmware too large (max ~3MB)' }));
              return;
            }
            const body = Buffer.concat(chunks).toString('utf8');
            const { ip, port = 3232, firmwareBase64, projectPath, boardId } = JSON.parse(body);
            if (!ip || typeof ip !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing or invalid ip' }));
              return;
            }
            const portNum = typeof port === 'number' ? port : parseInt(String(port), 10) || 3232;

            const t0 = Date.now();
            if (projectPath && typeof projectPath === 'string') {
              if (portNum !== 3232) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ota_service uses board OTA port 3232' }));
                return;
              }
              const root = getOtaWorkspaceRoot();
              const absProj = path.isAbsolute(projectPath)
                ? projectPath
                : path.join(root, projectPath);
              const bid =
                typeof boardId === 'number' && boardId >= 0 && boardId <= 254 ? boardId : 0;
              const { ok, reply } = await otaBuildFlash(ip, absProj, bid);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  success: ok,
                  bytesSent: 0,
                  durationMs: Date.now() - t0,
                  error: ok ? undefined : reply,
                }),
              );
              return;
            }
            if (firmwareBase64 && typeof firmwareBase64 === 'string') {
              if (portNum !== 3232) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'ota_service uses board OTA port 3232' }));
                return;
              }
              const firmwareBuffer = Buffer.from(firmwareBase64, 'base64');
              const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diablo-ota-'));
              const fp = path.join(dir, 'firmware.bin');
              try {
                fs.writeFileSync(fp, firmwareBuffer);
                const { ok, reply } = await otaFlashFirmwareFile(ip, fp);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    success: ok,
                    bytesSent: ok ? firmwareBuffer.length : 0,
                    durationMs: Date.now() - t0,
                    error: ok ? undefined : reply,
                  }),
                );
              } finally {
                try {
                  fs.rmSync(dir, { recursive: true, force: true });
                } catch {
                  /* ignore */
                }
              }
              return;
            }
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Provide firmwareBase64 or projectPath' }));
            return;
          } catch (err: any) {
            console.error('❌ OTA flash error:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message || 'OTA flash failed' }));
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

    return true;
  };
}
