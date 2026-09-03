/**
 * HTTP API routes for config management and Elodin DB queries.
 * Exports a request handler to be mounted on an existing HTTP server.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { IncomingMessage, ServerResponse } from 'http';
import { readConfig, writeConfig, getConfigPath, patchBoardField } from './routes/config.js';
import {
  listProfiles, switchProfile, createProfile, renameProfile, deleteProfile,
  getActiveProfileName, ensureSeeded, readActiveProfile, writeActiveProfile, deployActiveProfile,
  getActiveProfilePath, readStateCsv, writeStateCsv, isStateCsvName, STATE_CSVS,
} from './routes/config-profiles.js';
import { isCurrentLoopBoard } from './sensor-config.js';
import { sessionManager } from './session-manager.js';
import { isOperator } from './operators.js';
import { discoverProjects, getEnabledBoardsForFlash, getOtaWorkspaceRoot, BOARD_TYPE_TO_PROJECT } from './ota-build.js';
import { otaBuildFlash, otaFlashFirmwareFile } from './ota-service-cmd.js';
import { ElodinQueryClient, QueryOptions } from './elodin-query.js';
import { getBoardLogHistory, getBoardLogStats } from './board-logs.js';
import type { SensorUpdate } from './shared-types.js';

// ── Sensor config helpers ──────────────────────────────────────────────────

export interface SensorConfigEntry {
  /** 1-based channel / connector ID local to the board */
  id: number;
  /** Human-readable role name from config.toml, e.g. "Fuel Upstream" */
  role: string;
  /** board_id from config.toml boards section */
  boardId: number;
  /** Board IP address */
  boardIp: string;
  /** true if this sensor is on a high-pressure 4-20 mA PT board (config hp_pt_* fields) */
  isHpPt: boolean;
  /** true → eligible for calibration capture */
  inCalibrationSequence: boolean;
  /** Raw ADC entity string, e.g. "PT1.CH1" */
  entity: string;
  /** Calibrated entity string, e.g. "PT1_Cal.CH1" */
  calEntity: string;
}

function asBoardId(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Match FSW/Elodin: (board_id % 10) with 0 → 10 for PTn / TCn / RTDn / LCn. */
function elodinSlotFromBoardId(boardId: number): number {
  const m = boardId % 10;
  return m === 0 ? 10 : m;
}

function buildSensorConfig(): SensorConfigEntry[] {
  const config = readConfig();
  const boards = (config.boards || {}) as Record<string, any>;
  const sensors: SensorConfigEntry[] = [];

  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as Record<string, any>;
    if (board.type !== 'PT') continue;
    if (board.enabled === false) continue;

    const boardIp: string = board.ip || '';
    const boardId = asBoardId(board.board_id, 1);
    // The ADC reference is set once per board, so the interface is a property of the whole
    // board — every one of its sensor channels converts through the same path.
    const isHpBoard = isCurrentLoopBoard(board);

    // Determine which sensor_roles section to use for this board
    const boardRolesKey = `sensor_roles_${boardKey}`;
    let rolesSection: Record<string, any> = {};
    if ((config as any)[boardRolesKey]) {
      rolesSection = (config as any)[boardRolesKey] as Record<string, any>;
    } else if (config.sensor_roles) {
      rolesSection = config.sensor_roles as Record<string, any>;
    }

    // Every PT board uses its own [sensor_roles_<boardKey>] section — HP boards included
    // (no separate sensor_roles_pt2 section).
    for (const [roleName, channelIdRaw] of Object.entries(rolesSection)) {
      const channelId = typeof channelIdRaw === 'number' ? channelIdRaw : Number(channelIdRaw);
      if (!isFinite(channelId)) continue;

      const isHpPt = isHpBoard;
      const boardNumber = elodinSlotFromBoardId(boardId);

      sensors.push({
        id: channelId,
        role: roleName,
        boardId,
        boardIp,
        isHpPt,
        inCalibrationSequence: true,
        entity: `PT${boardNumber}.CH${channelId}`,
        calEntity: `PT${boardNumber}_Cal.CH${channelId}`,
      });
    }
  }

  // TC boards with sensor_roles_tc_board (e.g. chamber TCs)
  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as Record<string, any>;
    if (board.type !== 'TC') continue;
    if (board.enabled === false) continue;

    const boardRolesKey = `sensor_roles_${boardKey}`;
    const rolesSection = (config as any)[boardRolesKey] as Record<string, number> | undefined;
    if (!rolesSection || typeof rolesSection !== 'object') continue;

    const boardId = asBoardId(board.board_id, 51);
    const boardIp: string = board.ip || '';

    const boardNumber = elodinSlotFromBoardId(boardId);
    for (const [roleName, channelId] of Object.entries(rolesSection)) {
      const ch = typeof channelId === 'number' ? channelId : Number(channelId);
      if (!isFinite(ch)) continue;

      sensors.push({
        id: ch,
        role: roleName,
        boardId,
        boardIp,
        isHpPt: false,
        inCalibrationSequence: false,
        entity: `TC${boardNumber}.CH${ch}`,
        calEntity: `TC${boardNumber}_Cal.CH${ch}`,
      });
    }
  }

  // RTD boards: sensor_roles_<boardKey> or active_connectors with role "RTD ChN"
  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as Record<string, any>;
    if (board.type !== 'RTD') continue;
    if (board.enabled === false) continue;

    const boardId = asBoardId(board.board_id, 31);
    const boardIp: string = board.ip || '';
    const boardRolesKey = `sensor_roles_${boardKey}`;
    const rolesSection = (config as any)[boardRolesKey] as Record<string, number> | undefined;
    const active: number[] = Array.isArray(board.active_connectors) && board.active_connectors.length > 0
      ? (board.active_connectors as number[])
      : Array.from({ length: (board.num_sensors ?? 4) }, (_, i) => i + 1);

    const boardNumber = elodinSlotFromBoardId(boardId);
    if (rolesSection && typeof rolesSection === 'object') {
      for (const [roleName, channelId] of Object.entries(rolesSection)) {
        const ch = typeof channelId === 'number' ? channelId : Number(channelId);
        if (!isFinite(ch)) continue;
        sensors.push({
          id: ch,
          role: roleName,
          boardId,
          boardIp,
          isHpPt: false,
          inCalibrationSequence: false,
          entity: `RTD${boardNumber}.CH${ch}`,
          calEntity: `RTD${boardNumber}_Cal.CH${ch}`,
        });
      }
    } else {
      for (const ch of active) {
        sensors.push({
          id: ch,
          role: `RTD Ch${ch}`,
          boardId,
          boardIp,
          isHpPt: false,
          inCalibrationSequence: false,
          entity: `RTD${boardNumber}.CH${ch}`,
          calEntity: `RTD${boardNumber}_Cal.CH${ch}`,
        });
      }
    }
  }

  // LC boards: from active_connectors when no sensor_roles_<boardKey>; role "LC ChN"
  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as Record<string, any>;
    if (board.type !== 'LC') continue;
    if (board.enabled === false) continue;

    const boardId = asBoardId(board.board_id, 41);
    const boardIp: string = board.ip || '';
    const boardRolesKey = `sensor_roles_${boardKey}`;
    const rolesSection = (config as any)[boardRolesKey] as Record<string, number> | undefined;

    const boardNumber = elodinSlotFromBoardId(boardId);
    if (rolesSection && typeof rolesSection === 'object') {
      for (const [roleName, channelId] of Object.entries(rolesSection)) {
        const ch = typeof channelId === 'number' ? channelId : Number(channelId);
        if (!isFinite(ch)) continue;
        sensors.push({
          id: ch,
          role: roleName,
          boardId,
          boardIp,
          isHpPt: false,
          inCalibrationSequence: false,
          entity: `LC${boardNumber}.CH${ch}`,
          calEntity: `LC${boardNumber}_Cal.CH${ch}`,
        });
      }
    } else {
      const active: number[] = Array.isArray(board.active_connectors) && board.active_connectors.length > 0
        ? (board.active_connectors as number[])
        : Array.from({ length: (board.num_sensors ?? 4) }, (_, i) => i + 1);
      for (const ch of active) {
        sensors.push({
          id: ch,
          role: `LC Ch${ch}`,
          boardId,
          boardIp,
          isHpPt: false,
          inCalibrationSequence: false,
          entity: `LC${boardNumber}.CH${ch}`,
          calEntity: `LC${boardNumber}_Cal.CH${ch}`,
        });
      }
    }
  }

  // Sort: board order first, then channel id within board
  sensors.sort((a, b) => {
    if (a.boardId !== b.boardId) return a.boardId - b.boardId;
    return a.id - b.id;
  });

  return sensors;
}

/**
 * Average Hz of primary raw streams per board group from relay ingest (pre-WS-throttle).
 * Dynamic keys: `pt<n>` per PT board (n = board_id % 10) plus aggregated `tc`/`rtd`/`lc`/`act`/`enc`.
 * A group only appears once it has seen data — read a missing group as 0.
 */
export type BoardScanRateHz = Record<string, number>;

export interface DebugInfo {
  ingestConnected: boolean;
  ingestPacketsReceived: number;
  heartbeatPacketsReceived?: number;
  wsClients: number;
  sensorCacheSize: number;
  useRelay: boolean;
  boardScanRateHz?: BoardScanRateHz;
}

export interface APIHandlerOptions {
  getQueryClient?: () => ElodinQueryClient | null;
  getDebugInfo?: () => DebugInfo | null;
  onConfigUpdated?: () => void;
  /** A state-machine CSV was saved and deployed: rebuild derived maps and tell the sequencer to
   *  re-read (it exposes RELOAD_CONFIG, which re-loads both CSVs without a restart). */
  onStateCsvUpdated?: () => void;
  getEngineState?: () => number;
  getCalibrationStatus?: () => Promise<any>;
}

/**
 * Config edits require an approved operator. Identity is the `X-Auth-Email`
 * header Caddy injects on every proxied request; an empty header means no proxy
 * in front (local/dev/test stand) and is treated as operator — same rule the WS
 * control path uses in server.ts. Present-but-not-allowlisted → denied.
 */
function isConfigWriteAuthorized(req: IncomingMessage): boolean {
  const authEmail = ((req.headers['x-auth-email'] as string | undefined) || '').trim();
  return authEmail === '' ? true : isOperator(authEmail);
}

/** Collect and JSON-parse a request body. Rejects on invalid JSON. */
function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(body.trim() ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * Create an HTTP request handler for all /api/* routes.
 * Mount this on an existing http.Server — it does NOT create its own server.
 * Returns true if the request was handled, false if not (so the caller can fall through).
 */
export function createAPIHandler(opts: APIHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const { getQueryClient, getDebugInfo, onConfigUpdated, onStateCsvUpdated, getEngineState, getCalibrationStatus } = opts;

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const urlPath = (req.url ?? '').split('?')[0] ?? '';
    if (!urlPath.startsWith('/api/')) return false;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return true;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    try {
      if (url.pathname === '/api/config' && req.method === 'GET') {
        // The editor reads the ACTIVE PROFILE (the draft you edit), not the deployed config.toml.
        const config = readActiveProfile();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ config, active: getActiveProfileName() }));
      } else if (url.pathname === '/api/config' && req.method === 'POST') {
        // Save to the ACTIVE PROFILE. When idle, also deploy it to config.toml (the running file);
        // during a session config.toml is frozen — the write is a draft applied at the next start.
        if (!isConfigWriteAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not an approved operator' }));
          return true;
        }
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            const { config } = JSON.parse(body);
            const sessionActive = sessionManager.getStatus().active;
            console.log(`📝 Config save → active profile "${getActiveProfileName()}"${sessionActive ? ' (draft; config.toml frozen — session active)' : ' (+ deploy to config.toml)'}`);
            writeActiveProfile(config);
            if (!sessionActive) {
              deployActiveProfile();
              if (onConfigUpdated) {
                setImmediate(() => {
                  try { onConfigUpdated(); } catch (e) { console.warn('⚠️ onConfigUpdated handler threw:', e); }
                });
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, deployed: !sessionActive, message: sessionActive ? 'Saved as draft (applies at next session start)' : 'Config saved and deployed' }));
          } catch (error: any) {
            console.error('❌ Config save error:', error);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || 'Failed to save config' }));
          }
        });
      } else if (url.pathname === '/api/config/export' && req.method === 'GET') {
        // Raw config.toml download (backup). Read-only — no operator gate.
        try {
          const raw = fs.readFileSync(getConfigPath(), 'utf-8');
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="config.toml"',
          });
          res.end(raw);
        } catch (error: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message || 'Failed to read config' }));
        }
      } else if (url.pathname === '/api/config/import' && req.method === 'POST') {
        // Replace config.toml with an uploaded file (restore). Operators only.
        // Validate by writing then re-reading with the app's tolerant parser;
        // roll back to the previous contents if it fails to parse.
        if (!isConfigWriteAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not an approved operator' }));
          return true;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          // Import replaces the ACTIVE PROFILE (validated), then deploys to config.toml when idle —
          // same freeze rule as a save.
          const target = getActiveProfilePath();
          let previous: string | null = null;
          try {
            if (!body.trim()) throw new Error('Uploaded config is empty');
            previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
            fs.writeFileSync(target, body, 'utf-8');
            readConfig(target); // throws if the uploaded TOML is invalid
            const sessionActive = sessionManager.getStatus().active;
            if (!sessionActive) {
              deployActiveProfile();
              if (onConfigUpdated) {
                setImmediate(() => {
                  try { onConfigUpdated(); } catch (e) { console.warn('⚠️ onConfigUpdated handler threw:', e); }
                });
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, deployed: !sessionActive, message: sessionActive ? 'Imported as draft (applies at next session start)' : 'Config imported and deployed' }));
          } catch (error: any) {
            if (previous !== null) {
              try { fs.writeFileSync(target, previous, 'utf-8'); } catch { /* best effort */ }
            }
            console.error('❌ Config import error:', error);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || 'Invalid config file' }));
          }
        });
      } else if (url.pathname === '/api/states' && req.method === 'GET') {
        // The state list from the active profile's [[states]]. One source for the labels the GUI
        // used to keep in six separate maps, several of which had drifted — the top bar rendered
        // ids 18 and 19 as "STATE 18"/"STATE 19" because they were simply missing from its copy.
        try {
          const cfg = readActiveProfile();
          const raw = Array.isArray((cfg as any)?.states) ? (cfg as any).states : [];
          const states = raw
            .filter((e: any) => typeof e?.id === 'number' && typeof e?.name === 'string')
            .map((e: any) => ({
              id: e.id,
              name: e.name,
              isAbort: e.is_abort === true,
              isBoot: e.is_boot === true,
              // Absent coordinates mean "not on the control panel" — no separate hidden flag.
              panelRow: typeof e.panel_row === 'number' ? e.panel_row : null,
              panelCol: typeof e.panel_col === 'number' ? e.panel_col : null,
            }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ states }));
        } catch (error: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message || 'Failed to read states' }));
        }
      } else if (url.pathname === '/api/state-csv' && req.method === 'GET') {
        // Raw state-machine CSV from the ACTIVE PROFILE. Read-only — no operator gate, matching
        // /api/config/export.
        try {
          const which = String(url.searchParams.get('name') || '');
          if (!isStateCsvName(which)) throw new Error(`Unknown CSV "${which}"`);
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${STATE_CSVS[which]}"`,
          });
          res.end(readStateCsv(which));
        } catch (error: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message || 'Failed to read CSV' }));
        }
      } else if (url.pathname === '/api/state-csv' && req.method === 'POST') {
        // Write a state CSV into the active profile; deploy when idle (same freeze rule as a
        // config save — during a session it stays a draft applied at the next start).
        if (!isConfigWriteAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not an approved operator' }));
          return true;
        }
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const which = String(url.searchParams.get('name') || '');
            if (!isStateCsvName(which)) throw new Error(`Unknown CSV "${which}"`);
            if (!body.trim()) throw new Error('CSV is empty');
            // A header row plus at least one data row; anything less is a truncated upload, and a
            // CSV that parses to nothing silently disables every actuator for every state.
            const rows = body.split('\n').map((l) => l.trim()).filter(Boolean);
            if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row');
            const sessionActive = sessionManager.getStatus().active;
            const deployed = writeStateCsv(which, body, !sessionActive);
            if (deployed && onStateCsvUpdated) {
              setImmediate(() => {
                try { onStateCsvUpdated(); } catch (e) { console.warn('⚠️ onStateCsvUpdated handler threw:', e); }
              });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: true,
              deployed,
              message: deployed ? 'Saved and applied' : 'Saved as draft (applies at next session start)',
            }));
          } catch (error: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || 'Invalid CSV' }));
          }
        });
      } else if (url.pathname === '/api/config/profiles' && req.method === 'GET') {
        // List profiles + which is active + whether a session freezes deploys/switching.
        ensureSeeded();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          profiles: listProfiles(),
          active: getActiveProfileName(),
          sessionActive: sessionManager.getStatus().active,
        }));
      } else if (url.pathname === '/api/config/profiles/switch' && req.method === 'POST') {
        // Switch the active profile and deploy it. Operators only; blocked while a session runs.
        if (!isConfigWriteAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not an approved operator' }));
          return true;
        }
        try {
          const { name } = await readJsonBody(req);
          if (sessionManager.getStatus().active) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot switch config while a session is running' }));
            return true;
          }
          switchProfile(name);
          if (onConfigUpdated) setImmediate(() => { try { onConfigUpdated(); } catch (e) { console.warn('⚠️ onConfigUpdated threw:', e); } });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, active: getActiveProfileName() }));
        } catch (error: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error?.message || 'Failed to switch profile' }));
        }
      } else if (url.pathname === '/api/config/profiles/create' && req.method === 'POST') {
        if (!isConfigWriteAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not an approved operator' }));
          return true;
        }
        try {
          const { name, from } = await readJsonBody(req);
          createProfile(name, from);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, profiles: listProfiles() }));
        } catch (error: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error?.message || 'Failed to create profile' }));
        }
      } else if (url.pathname === '/api/config/profiles/rename' && req.method === 'POST') {
        if (!isConfigWriteAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not an approved operator' }));
          return true;
        }
        try {
          const { name, newName } = await readJsonBody(req);
          renameProfile(name, newName);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, profiles: listProfiles(), active: getActiveProfileName() }));
        } catch (error: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error?.message || 'Failed to rename profile' }));
        }
      } else if (url.pathname === '/api/config/profiles/delete' && req.method === 'POST') {
        if (!isConfigWriteAuthorized(req)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not an approved operator' }));
          return true;
        }
        try {
          const { name } = await readJsonBody(req);
          deleteProfile(name);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, profiles: listProfiles() }));
        } catch (error: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error?.message || 'Failed to delete profile' }));
        }
      } else if (url.pathname === '/api/query' && req.method === 'GET') {
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
      } else if (url.pathname === '/api/pressure-limits' && req.method === 'GET') {
        // Return pressure limits from config.toml (NOP, MEOP, POP per fluid system)
        const config = readConfig();
        const limits = config.pressure_limits || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pressure_limits: limits }));
      } else if (url.pathname === '/api/gui-config' && req.method === 'GET') {
        // GUI-driven config lists from config.toml [gui]: the ordered top-bar
        // pressure gauges ([[gui.pressure_bars]]) and the tab-bar tabs+order
        // (gui.tabs). Fresh per request → reflects edits live. Bar NOP/MEOP come
        // from [pressure_limits]; tab ids index the frontend view catalog.
        const config = readConfig();
        const gui = config.gui ?? {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          pressure_bars: gui.pressure_bars ?? [],
          tabs: gui.tabs ?? [],
          // [gui.groups]: page name → ordered role-name list (explicit sensor→page membership).
          groups: gui.groups ?? {},
        }));
      } else if (url.pathname === '/api/sensor-config' && req.method === 'GET') {
        // Return sensor configuration derived from config.toml:
        // role names, board assignments, entity strings, calibration flags
        const sensorConfig = buildSensorConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sensors: sensorConfig }));
      } else if (url.pathname === '/api/sensors' && req.method === 'GET') {
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
      } else if (url.pathname === '/api/board-logs' && req.method === 'GET') {
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
      } else if (url.pathname === '/api/board-logs/stats' && req.method === 'GET') {
        // Cumulative per-board log counters { boardId: { received, truncated } }.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ stats: getBoardLogStats() }));
      } else if (url.pathname === '/api/board-log-mode' && req.method === 'POST') {
        // Set one board's logging/serial-print mode byte (0..3) via a surgical
        // single-field edit of config.toml. Operators only. config_broadcast_service
        // re-reads config.toml and sends the board the new byte on its next cycle.
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
      } else if (url.pathname === '/api/debug' && req.method === 'GET') {
        const info = getDebugInfo ? getDebugInfo() : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info ?? { error: 'Debug info not available' }));
      } else if (url.pathname === '/api/engine_state' && req.method === 'GET') {
        const engineState = getEngineState ? getEngineState() : 0;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ engineState }));
      } else if (url.pathname === '/api/calibration_status' && req.method === 'GET') {
        const status = getCalibrationStatus ? await getCalibrationStatus() : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status ?? { error: 'Calibration status not available' }));
      } else if (url.pathname === '/api/cubic_calibration' && req.method === 'GET') {
        // Read-only view of the calibration service's cubic_calibration.json (the service is the
        // sole writer; it rewrites the file atomically per capture). Search the same candidate
        // roots loadPTCalibration() uses, covering both dev (tsx) and dist layouts.
        const candidates = [
          path.join(__dirname, '../../../scripts/calibration/calibrations/cubic_calibration.json'),
          path.join(__dirname, '../../../../scripts/calibration/calibrations/cubic_calibration.json'),
          path.join(process.cwd(), 'scripts/calibration/calibrations/cubic_calibration.json'),
          path.join(process.cwd(), '../../scripts/calibration/calibrations/cubic_calibration.json'),
        ];
        let body: string | null = null;
        for (const c of candidates) {
          try {
            if (fs.existsSync(c)) { body = fs.readFileSync(c, 'utf8'); break; }
          } catch { /* try next candidate */ }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (body == null) {
          res.end(JSON.stringify({ cubic_state: {} }));
        } else {
          try { JSON.parse(body); res.end(body); }
          catch { res.end(JSON.stringify({ cubic_state: {} })); }  // partial/corrupt → empty
        }
      } else if (url.pathname === '/api/config_packets' && req.method === 'GET') {
        // Config packets now built by config_broadcast_service.py (standalone). Return empty.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ packets: [] }));
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
