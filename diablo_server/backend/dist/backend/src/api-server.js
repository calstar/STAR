/**
 * HTTP API routes for config management and Elodin DB queries.
 * Exports a request handler to be mounted on an existing HTTP server.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfig, writeConfig } from './routes/config.js';
import { discoverProjects, getEnabledBoardsForFlash, getOtaWorkspaceRoot, BOARD_TYPE_TO_PROJECT } from './ota-build.js';
import { otaBuildFlash, otaFlashFirmwareFile } from './ota-service-cmd.js';
function asBoardId(raw, fallback) {
    if (typeof raw === 'number' && Number.isFinite(raw))
        return raw;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}
/** Match FSW/Elodin: (board_id % 10) with 0 → 10 for PTn / TCn / RTDn / LCn. */
function elodinSlotFromBoardId(boardId) {
    const m = boardId % 10;
    return m === 0 ? 10 : m;
}
function buildSensorConfig() {
    const config = readConfig();
    const boards = (config.boards || {});
    const sensors = [];
    for (const [boardKey, boardRaw] of Object.entries(boards)) {
        const board = boardRaw;
        if (board.type !== 'PT')
            continue;
        if (board.enabled === false)
            continue;
        const boardIp = board.ip || '';
        const boardId = asBoardId(board.board_id, 1);
        const isHpBoard = Array.isArray(board.hp_pt_connectors) && board.hp_pt_connectors.length > 0;
        const excitationConnectorId = board.excitation_connector_id ?? -1;
        const hpPtConnectors = new Set(isHpBoard ? board.hp_pt_connectors : []);
        // Determine which sensor_roles section to use for this board
        const boardRolesKey = `sensor_roles_${boardKey}`;
        let rolesSection = {};
        if (config[boardRolesKey]) {
            rolesSection = config[boardRolesKey];
        }
        else if (config.sensor_roles) {
            rolesSection = config.sensor_roles;
        }
        // sensor_roles_pt2 uses the same format but is stored separately
        const pt2Roles = isHpBoard
            ? (config.sensor_roles_pt2 || {})
            : {};
        // Build entries from the relevant roles section
        const effectiveRoles = Object.keys(pt2Roles).length > 0 && isHpBoard ? pt2Roles : rolesSection;
        for (const [roleName, channelIdRaw] of Object.entries(effectiveRoles)) {
            const channelId = typeof channelIdRaw === 'number' ? channelIdRaw : Number(channelIdRaw);
            if (!isFinite(channelId))
                continue;
            // Skip excitation connector — it is never a sensor
            if (isHpBoard && channelId === excitationConnectorId)
                continue;
            // Skip channels not in hp_pt_connectors for HP boards
            if (isHpBoard && !hpPtConnectors.has(channelId))
                continue;
            const isHpPt = isHpBoard && hpPtConnectors.has(channelId);
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
        const board = boardRaw;
        if (board.type !== 'TC')
            continue;
        if (board.enabled === false)
            continue;
        const boardRolesKey = `sensor_roles_${boardKey}`;
        const rolesSection = config[boardRolesKey];
        if (!rolesSection || typeof rolesSection !== 'object')
            continue;
        const boardId = asBoardId(board.board_id, 51);
        const boardIp = board.ip || '';
        const boardNumber = elodinSlotFromBoardId(boardId);
        for (const [roleName, channelId] of Object.entries(rolesSection)) {
            const ch = typeof channelId === 'number' ? channelId : Number(channelId);
            if (!isFinite(ch))
                continue;
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
        const board = boardRaw;
        if (board.type !== 'RTD')
            continue;
        if (board.enabled === false)
            continue;
        const boardId = asBoardId(board.board_id, 31);
        const boardIp = board.ip || '';
        const boardRolesKey = `sensor_roles_${boardKey}`;
        const rolesSection = config[boardRolesKey];
        const active = Array.isArray(board.active_connectors) && board.active_connectors.length > 0
            ? board.active_connectors
            : Array.from({ length: (board.num_sensors ?? 4) }, (_, i) => i + 1);
        const boardNumber = elodinSlotFromBoardId(boardId);
        if (rolesSection && typeof rolesSection === 'object') {
            for (const [roleName, channelId] of Object.entries(rolesSection)) {
                const ch = typeof channelId === 'number' ? channelId : Number(channelId);
                if (!isFinite(ch))
                    continue;
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
        }
        else {
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
        const board = boardRaw;
        if (board.type !== 'LC')
            continue;
        if (board.enabled === false)
            continue;
        const boardId = asBoardId(board.board_id, 41);
        const boardIp = board.ip || '';
        const boardRolesKey = `sensor_roles_${boardKey}`;
        const rolesSection = config[boardRolesKey];
        const boardNumber = elodinSlotFromBoardId(boardId);
        if (rolesSection && typeof rolesSection === 'object') {
            for (const [roleName, channelId] of Object.entries(rolesSection)) {
                const ch = typeof channelId === 'number' ? channelId : Number(channelId);
                if (!isFinite(ch))
                    continue;
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
        }
        else {
            const active = Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                ? board.active_connectors
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
        if (a.boardId !== b.boardId)
            return a.boardId - b.boardId;
        return a.id - b.id;
    });
    return sensors;
}
/**
 * Create an HTTP request handler for all /api/* routes.
 * Mount this on an existing http.Server — it does NOT create its own server.
 * Returns true if the request was handled, false if not (so the caller can fall through).
 */
export function createAPIHandler(opts = {}) {
    const { getQueryClient, getDebugInfo, onConfigUpdated, getEngineState, getCalibrationStatus } = opts;
    return async (req, res) => {
        const urlPath = (req.url ?? '').split('?')[0] ?? '';
        if (!urlPath.startsWith('/api/'))
            return false;
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
                // Read config
                const config = readConfig();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ config }));
            }
            else if (url.pathname === '/api/config' && req.method === 'POST') {
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
                                    try {
                                        onConfigUpdated();
                                    }
                                    catch (e) {
                                        console.warn('⚠️ onConfigUpdated handler threw:', e);
                                    }
                                });
                            }
                        }
                        catch (e) {
                            console.warn('⚠️ onConfigUpdated handler threw:', e);
                        }
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, message: 'Config saved successfully' }));
                    }
                    catch (error) {
                        console.error('❌ Config save error:', error);
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: error.message || 'Failed to save config' }));
                    }
                });
            }
            else if (url.pathname === '/api/query' && req.method === 'GET') {
                // Query historical data from Elodin DB
                const currentQueryClient = getQueryClient ? getQueryClient() : null;
                if (!currentQueryClient) {
                    res.writeHead(503, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Query client not available' }));
                    return;
                }
                const packetIdHigh = parseInt(url.searchParams.get('packet_id_high') || '0x20', 16);
                const packetIdLow = parseInt(url.searchParams.get('packet_id_low') || '0x11', 16);
                const startTime = url.searchParams.get('start_time') ? parseInt(url.searchParams.get('start_time')) : undefined;
                const endTime = url.searchParams.get('end_time') ? parseInt(url.searchParams.get('end_time')) : undefined;
                const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')) : 1000;
                const queryOptions = {
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
                    .catch((error) => {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: error.message }));
                });
            }
            else if (url.pathname === '/api/pressure-limits' && req.method === 'GET') {
                // Return pressure limits from config.toml (NOP, MEOP, POP per fluid system)
                const config = readConfig();
                const limits = config.pressure_limits || {};
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ pressure_limits: limits }));
            }
            else if (url.pathname === '/api/sensor-config' && req.method === 'GET') {
                // Return sensor configuration derived from config.toml:
                // role names, board assignments, entity strings, calibration flags
                const sensorConfig = buildSensorConfig();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ sensors: sensorConfig }));
            }
            else if (url.pathname === '/api/sensors' && req.method === 'GET') {
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
            }
            else if (url.pathname.startsWith('/api/sensors/') && req.method === 'GET') {
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
            }
            else if (url.pathname === '/api/debug' && req.method === 'GET') {
                const info = getDebugInfo ? getDebugInfo() : null;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(info ?? { error: 'Debug info not available' }));
            }
            else if (url.pathname === '/api/engine_state' && req.method === 'GET') {
                const engineState = getEngineState ? getEngineState() : 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ engineState }));
            }
            else if (url.pathname === '/api/calibration_status' && req.method === 'GET') {
                const status = getCalibrationStatus ? await getCalibrationStatus() : null;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(status ?? { error: 'Calibration status not available' }));
            }
            else if (url.pathname === '/api/config_packets' && req.method === 'GET') {
                // Config packets now built by config_broadcast_service.py (standalone). Return empty.
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ packets: [] }));
            }
            else if (url.pathname === '/api/ota-flash/projects' && req.method === 'GET') {
                const projects = discoverProjects();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ projects }));
            }
            else if (url.pathname === '/api/ota-flash/flash-all' && req.method === 'POST') {
                const boards = getEnabledBoardsForFlash();
                if (boards.length === 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'No enabled boards in config' }));
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                });
                const sendSSE = (event, data) => {
                    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
                };
                sendSSE('progress', { message: `Starting flash-all for ${boards.length} boards (ota_service build+flash)…` });
                const results = [];
                let flashed = 0;
                let failed = 0;
                const root = getOtaWorkspaceRoot();
                for (let i = 0; i < boards.length; i++) {
                    const b = boards[i];
                    const rel = BOARD_TYPE_TO_PROJECT[b.type];
                    if (!rel) {
                        const r = { ...b, success: false, error: `No firmware project for type ${b.type}` };
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
                        const r = { ...b, success: true };
                        results.push(r);
                        sendSSE('board_result', r);
                        flashed++;
                    }
                    else {
                        const r = { ...b, success: false, error: reply };
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
            }
            else if (url.pathname === '/api/ota-flash' && req.method === 'POST') {
                const chunks = [];
                let totalLen = 0;
                const MAX_BODY = 4 * 1024 * 1024; // 4MB (firmware ~2MB base64)
                req.on('data', (chunk) => {
                    totalLen += chunk.length;
                    if (totalLen <= MAX_BODY)
                        chunks.push(chunk);
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
                            const bid = typeof boardId === 'number' && boardId >= 0 && boardId <= 254 ? boardId : 0;
                            const { ok, reply } = await otaBuildFlash(ip, absProj, bid);
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({
                                success: ok,
                                bytesSent: 0,
                                durationMs: Date.now() - t0,
                                error: ok ? undefined : reply,
                            }));
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
                                res.end(JSON.stringify({
                                    success: ok,
                                    bytesSent: ok ? firmwareBuffer.length : 0,
                                    durationMs: Date.now() - t0,
                                    error: ok ? undefined : reply,
                                }));
                            }
                            finally {
                                try {
                                    fs.rmSync(dir, { recursive: true, force: true });
                                }
                                catch {
                                    /* ignore */
                                }
                            }
                            return;
                        }
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Provide firmwareBase64 or projectPath' }));
                        return;
                    }
                    catch (err) {
                        console.error('❌ OTA flash error:', err);
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err.message || 'OTA flash failed' }));
                    }
                });
            }
            else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        }
        catch (error) {
            console.error('API error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return true;
    };
}
