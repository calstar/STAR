/**
 * HTTP API server for config management and Elodin DB queries
 * Runs alongside WebSocket server
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readConfig, writeConfig } from './routes/config.js';
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
  wsClients: number;
  sensorCacheSize: number;
  useRelay: boolean;
}

export function startAPIServer(
  getQueryClient?: () => ElodinQueryClient | null,
  getDebugInfo?: () => DebugInfo | null
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
