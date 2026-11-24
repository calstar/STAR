/**
 * api/ota — firmware projects and over-the-air flashing.  [WP7 1.12]
 *
 * Owns: the OTA temp directories for the duration of one request; `MAX_BODY` and the SSE closure
 * live inside the bodies, unchanged. Must not know about: `server/*`, sessions, `api-server.ts`.
 * Talks to `ota_service` through `ota-service-cmd.ts`. Contract: `lifecycle/golden/ota.txt`
 * (including `POST /api/ota-flash` as the viewer → 403), `http.txt` (400s); `flash-all` as the
 * viewer is a 403 in H9's vitest (D72). Both POST routes are behind the operator gate
 * (`isConfigWriteAuthorized`, SEC-2; no `X-Auth-Email` stays allowed, as on every gated route).
 * A build names its project by `project`, a name from `GET /api/ota-flash/projects`, which the
 * server resolves to a directory; a client path (`projectPath`) is refused, because `pio run`
 * executes the project's `extra_scripts` (SEC-3). Kept: a throw after the SSE headers leaves the
 * response open (D-API3). Import-time effects: none.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { discoverProjects, getEnabledBoardsForFlash, getOtaWorkspaceRoot, resolveProjectByName, BOARD_TYPE_TO_PROJECT } from '../ota-build.js';
import { otaBuildFlash, otaFlashFirmwareFile } from '../ota-service-cmd.js';
import { isConfigWriteAuthorized } from './http.js';
import type { APIHandlerOptions } from './http.js';

function refuseNonOperator(res: ServerResponse): true {
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not an approved operator' }));
  return true;
}

export async function handleOtaRequest(req: IncomingMessage, res: ServerResponse, url: URL, opts: APIHandlerOptions): Promise<boolean> {
  if (url.pathname === '/api/ota-flash/projects' && req.method === 'GET') {
    const projects = discoverProjects();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ projects }));
    return true;
  }
  if (url.pathname === '/api/ota-flash/flash-all' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) return refuseNonOperator(res);
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
    return true;
  }
  if (url.pathname === '/api/ota-flash' && req.method === 'POST') {
    if (!isConfigWriteAuthorized(req)) return refuseNonOperator(res);
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
        const { ip, port = 3232, firmwareBase64, project, projectPath, boardId } = JSON.parse(body);
        if (!ip || typeof ip !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid ip' }));
          return;
        }
        const portNum = typeof port === 'number' ? port : parseInt(String(port), 10) || 3232;

        const t0 = Date.now();
        if (projectPath !== undefined) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'projectPath is not accepted; send project, a name from GET /api/ota-flash/projects' }));
          return;
        }
        if (project !== undefined) {
          if (portNum !== 3232) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ota_service uses board OTA port 3232' }));
            return;
          }
          const absProj = typeof project === 'string' ? resolveProjectByName(project) : null;
          if (!absProj) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Unknown firmware project: ${JSON.stringify(project)}` }));
            return;
          }
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
        res.end(JSON.stringify({ error: 'Provide firmwareBase64 or project' }));
        return;
      } catch (err: any) {
        console.error('❌ OTA flash error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'OTA flash failed' }));
      }
    });
    return true;
  }
  return false;
}
