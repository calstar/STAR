/**
 * HTTP API server for config management and Elodin DB queries
 * Runs alongside WebSocket server
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readConfig, writeConfig } from './routes/config.js';
import { uploadFirmware } from './ota-flash.js';
import { discoverProjects, buildProject, flashAllBoards, type FlashAllBoard } from './ota-build.js';
import { ElodinQueryClient, QueryOptions } from './elodin-query.js';
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
  /** true if this sensor is a high-pressure 4-20 mA PT (sensor_roles_pt2) */
  isHpPt: boolean;
  /** true → eligible for calibration capture */
  inCalibrationSequence: boolean;
  /** Raw ADC entity string, e.g. "PT.Fuel_Upstream" */
  entity: string;
  /** Calibrated PSI entity string, e.g. "PT_Cal.Fuel_Upstream" */
  calEntity: string;
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
    const boardId: number = typeof board.board_id === 'number' ? board.board_id : 1;
    const isHpBoard = Array.isArray(board.hp_pt_connectors) && board.hp_pt_connectors.length > 0;
    const excitationConnectorId: number = board.excitation_connector_id ?? -1;
    const hpPtConnectors: Set<number> = new Set(
      isHpBoard ? (board.hp_pt_connectors as number[]) : []
    );

    // Determine which sensor_roles section to use for this board
    const boardRolesKey = `sensor_roles_${boardKey}`;
    let rolesSection: Record<string, any> = {};
    if ((config as any)[boardRolesKey]) {
      rolesSection = (config as any)[boardRolesKey] as Record<string, any>;
    } else if (config.sensor_roles) {
      rolesSection = config.sensor_roles as Record<string, any>;
    }

    // sensor_roles_pt2 uses the same format but is stored separately
    const pt2Roles = isHpBoard
      ? ((config.sensor_roles_pt2 || {}) as Record<string, any>)
      : {};

    // Build entries from the relevant roles section
    const effectiveRoles = Object.keys(pt2Roles).length > 0 && isHpBoard ? pt2Roles : rolesSection;

    for (const [roleName, channelIdRaw] of Object.entries(effectiveRoles)) {
      const channelId = typeof channelIdRaw === 'number' ? channelIdRaw : Number(channelIdRaw);
      if (!isFinite(channelId)) continue;

      // Skip excitation connector — it is never a sensor
      if (isHpBoard && channelId === excitationConnectorId) continue;

      // Skip channels not in hp_pt_connectors for HP boards
      if (isHpBoard && !hpPtConnectors.has(channelId)) continue;

      const entityBase = roleName.replace(/\s+/g, '_');
      const isHpPt = isHpBoard && hpPtConnectors.has(channelId);

      sensors.push({
        id: channelId,
        role: roleName,
        boardId,
        boardIp,
        isHpPt,
        inCalibrationSequence: true,
        entity: `PT.${entityBase}`,
        calEntity: `PT_Cal.${entityBase}`,
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

    const boardId: number = typeof board.board_id === 'number' ? board.board_id : 51;
    const boardIp: string = board.ip || '';

    for (const [roleName, channelId] of Object.entries(rolesSection)) {
      const ch = typeof channelId === 'number' ? channelId : Number(channelId);
      if (!isFinite(ch)) continue;

      const entityBase = roleName.replace(/\s+/g, '_');
      sensors.push({
        id: ch,
        role: roleName,
        boardId,
        boardIp,
        isHpPt: false,
        inCalibrationSequence: false,
        entity: `TC.${entityBase}`,
        calEntity: `TC_Cal.${entityBase}`,
      });
    }
  }

  // RTD boards: sensor_roles_<boardKey> or active_connectors with role "RTD ChN"
  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as Record<string, any>;
    if (board.type !== 'RTD') continue;
    if (board.enabled === false) continue;

    const boardId: number = typeof board.board_id === 'number' ? board.board_id : 31;
    const boardIp: string = board.ip || '';
    const boardRolesKey = `sensor_roles_${boardKey}`;
    const rolesSection = (config as any)[boardRolesKey] as Record<string, number> | undefined;
    const active: number[] = Array.isArray(board.active_connectors) && board.active_connectors.length > 0
      ? (board.active_connectors as number[])
      : Array.from({ length: (board.num_sensors ?? 4) }, (_, i) => i + 1);

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
          entity: `RTD.CH${ch}`,
          calEntity: `RTD_Cal.CH${ch}`,
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
          entity: `RTD.CH${ch}`,
          calEntity: `RTD_Cal.CH${ch}`,
        });
      }
    }
  }

  // LC boards: from active_connectors when no sensor_roles_<boardKey>; role "LC ChN"
  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as Record<string, any>;
    if (board.type !== 'LC') continue;
    if (board.enabled === false) continue;

    const boardId: number = typeof board.board_id === 'number' ? board.board_id : 41;
    const boardIp: string = board.ip || '';
    const boardRolesKey = `sensor_roles_${boardKey}`;
    const rolesSection = (config as any)[boardRolesKey] as Record<string, number> | undefined;

    if (rolesSection && typeof rolesSection === 'object') {
      for (const [roleName, channelId] of Object.entries(rolesSection)) {
        const ch = typeof channelId === 'number' ? channelId : Number(channelId);
        if (!isFinite(ch)) continue;
        const entityBase = roleName.replace(/\s+/g, '_');
        sensors.push({
          id: ch,
          role: roleName,
          boardId,
          boardIp,
          isHpPt: false,
          inCalibrationSequence: false,
          entity: `LC.${entityBase}`,
          calEntity: `LC_Cal.${entityBase}`,
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
          entity: `LC.CH${ch}`,
          calEntity: `LC_Cal.CH${ch}`,
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

const API_PORT = parseInt(process.env.API_PORT || '8082', 10);

export interface DebugInfo {
  relayConnected: boolean;
  relayPacketsReceived: number;
  heartbeatPacketsReceived?: number;
  wsClients: number;
  sensorCacheSize: number;
  useRelay: boolean;
}

export function startAPIServer(
  getQueryClient?: () => ElodinQueryClient | null,
  getDebugInfo?: () => DebugInfo | null,
  onConfigUpdated?: () => void,
  getEngineState?: () => number,
  getCalibrationStatus?: () => Promise<any>
): void {
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
            console.log(`📝 Received config save request`);
            writeConfig(config);
            try {
              if (onConfigUpdated) {
                setImmediate(() => {
                  try { onConfigUpdated(); } catch (e) { console.warn('⚠️ onConfigUpdated handler threw:', e); }
                });
              }
            } catch (e) {
              console.warn('⚠️ onConfigUpdated handler threw:', e);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Config saved successfully' }));
          } catch (error: any) {
            console.error('❌ Config save error:', error);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || 'Failed to save config' }));
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
      } else if (url.pathname === '/api/pressure-limits' && req.method === 'GET') {
        // Return pressure limits from config.toml (NOP, MEOP, POP per fluid system)
        const config = readConfig();
        const limits = config.pressure_limits || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pressure_limits: limits }));
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
          return;
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
      } else if (url.pathname === '/api/config_packets' && req.method === 'GET') {
        // Config packets now built by config_broadcast_service.py (standalone). Return empty.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ packets: [] }));
      } else if (url.pathname === '/api/ota-flash/projects' && req.method === 'GET') {
        const projects = discoverProjects();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects }));
      } else if (url.pathname === '/api/ota-flash/flash-all' && req.method === 'POST') {
        const getBoards = (): FlashAllBoard[] => {
          const config = readConfig();
          const boards = (config.boards || {}) as Record<string, any>;
          const out: FlashAllBoard[] = [];
          for (const [key, raw] of Object.entries(boards)) {
            const b = raw as any;
            if (b.enabled === false) continue;
            const type = b.type || 'UNKNOWN';
            const ip = typeof b.ip === 'string' ? b.ip : '';
            const boardId = typeof b.board_id === 'number' ? b.board_id : b.board_number ?? 1;
            if (!ip || !type) continue;
            out.push({ key, type, ip, boardId });
          }
          return out;
        };
        const boards = getBoards();
        if (boards.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'No enabled boards in config' }));
          return;
        }
        const progressLog: string[] = [];
        const result = await flashAllBoards(getBoards, (msg) => {
          progressLog.push(msg);
          console.log(`[FlashAll] ${msg}`);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...result, progressLog }));
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
            const { ip, port = 3232, firmwareBase64, projectPath } = JSON.parse(body);
            if (!ip || typeof ip !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing or invalid ip' }));
              return;
            }
            const portNum = typeof port === 'number' ? port : parseInt(String(port), 10) || 3232;

            let firmwareBuffer: Buffer;
            if (projectPath && typeof projectPath === 'string') {
              // Build from DiabloAvionics project
              const buildResult = await buildProject(projectPath);
              if (!buildResult.success || !buildResult.firmwareBuffer) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: false,
                  bytesSent: 0,
                  durationMs: 0,
                  error: buildResult.error || 'Build failed',
                  buildOutput: buildResult.buildOutput,
                }));
                return;
              }
              firmwareBuffer = buildResult.firmwareBuffer;
            } else if (firmwareBase64 && typeof firmwareBase64 === 'string') {
              firmwareBuffer = Buffer.from(firmwareBase64, 'base64');
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Provide firmwareBase64 or projectPath' }));
              return;
            }

            const result = await uploadFirmware(firmwareBuffer, ip, portNum);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
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
  });

  // Register error handler BEFORE calling listen()
  server.on('error', (error: any) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${API_PORT} already in use. Free it and restart: fuser -k ${API_PORT}/tcp`);
      process.exit(1);
    } else {
      console.error('❌ API server error:', error);
    }
  });

  server.listen(API_PORT, () => {
    console.log(`📡 API server listening on port ${API_PORT}`);
  });
}
