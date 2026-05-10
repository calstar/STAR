/**
 * Sensor configuration loading and HP PT conversion logic.
 * Extracted from server.ts — loadSensorRoleMap, loadHpPtConfig, convertHpPtToPressure.
 */
import { readConfig } from './routes/config.js';
/**
 * Build actuator channel → entity map from config.toml actuator_roles.
 * Used so Elodin parser uses same names as config (replica of backend/DB).
 */
export function loadActuatorChannelToEntityMap() {
    const out = {};
    try {
        const config = readConfig();
        const roles = (config.actuator_roles || {});
        for (const [name, value] of Object.entries(roles)) {
            if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number') {
                const localChannel = value[1];
                const boardId = (value.length >= 3 && typeof value[2] === 'number') ? value[2] : 11;
                // Per-board channel mapping (for [0x30], [0x31] — DAQ bridge resolves by source IP)
                out[localChannel] = `ACT.${name.replace(/\s+/g, '_')}`;
                // Global channel mapping (for [0x32] — sequencer publishes with global IDs)
                const globalChannel = (boardId - 11) * 10 + localChannel;
                out[globalChannel] = `ACT.${name.replace(/\s+/g, '_')}`;
            }
        }
    }
    catch (_) { /* use empty map */ }
    return out;
}
/**
 * Load sensor_roles from config.toml and build channel ID → entity name maps.
 * Matches combined_gui.py's CONFIG.get_sensor_role() behavior.
 *
 * Returns { channelToEntityMap, boardChannelToEntityMaps }.
 */
export function loadSensorRoleMap() {
    const boardChannelToEntityMaps = new Map();
    let channelToEntityMap = {};
    try {
        const config = readConfig();
        // Config has [sensor_roles_pt_board] and [sensor_roles_pt2], NOT [sensor_roles]
        const sensorRolesPtBoard = config.sensor_roles_pt_board || {};
        const sensorRolesPt2 = config.sensor_roles_pt2 || {};
        const boards = config.boards || {};
        // Build reverse map: channel_id → role_name from BOTH PT boards
        const reverseMap = {};
        // PT board 1 (sensor_roles_pt_board): payload channel byte IS the connector id (1-indexed). No +1.
        for (const [roleName, channelId] of Object.entries(sensorRolesPtBoard)) {
            if (typeof channelId === 'number' && channelId >= 1 && channelId <= 10) {
                const entityName = roleName.replace(/\s+/g, '_');
                reverseMap[channelId] = `PT_Cal.${entityName}`;
            }
        }
        // PT board 2 (sensor_roles_pt2): reverseMap keys use connector+10 so HP PT roles don’t collide with board 1’s channel ids in this legacy map (hardcoded here, not from config).
        for (const [roleName, channelId] of Object.entries(sensorRolesPt2)) {
            if (typeof channelId === 'number' && channelId >= 1 && channelId <= 10) {
                const entityName = roleName.replace(/\s+/g, '_');
                reverseMap[channelId + 10] = `PT_Cal.${entityName}`; // payloadCh for connector 1 = 11
            }
        }
        channelToEntityMap = reverseMap;
        console.log(`📋 Loaded sensor role map from config.toml (${Object.keys(reverseMap).length} channels):`, channelToEntityMap);
        // Build board-specific mappings to prevent cross-contamination
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw;
            const supportedTypes = ['PT', 'LC', 'RTD', 'TC'];
            if (supportedTypes.includes(board.type) && board.enabled !== false && board.ip) {
                const boardIp = board.ip;
                const isHpBoard = Array.isArray(board.hp_pt_connectors) && board.hp_pt_connectors.length > 0;
                const excitationId = typeof board.excitation_connector_id === 'number' ? board.excitation_connector_id : -1;
                // HP PT board uses sensor_roles_pt2; others use sensor_roles_<boardKey> (e.g. sensor_roles_pt_board)
                const boardSensorRolesKey = isHpBoard ? 'sensor_roles_pt2' : `sensor_roles_${boardKey}`;
                const boardSensorRoles = config[boardSensorRolesKey] || sensorRolesPtBoard;
                const boardMap = {};
                for (const [roleName, channelId] of Object.entries(boardSensorRoles)) {
                    if (typeof channelId !== 'number' || channelId < 1 || channelId > 10)
                        continue;
                    if (isHpBoard && channelId === excitationId)
                        continue;
                    if (isHpBoard && !board.hp_pt_connectors.includes(channelId))
                        continue;
                    const entityName = roleName.replace(/\s+/g, '_');
                    const prefix = board.type === 'PT' ? 'PT_Cal' : board.type;
                    const entity = `${prefix}.${entityName}`;
                    boardMap[channelId] = entity;
                    // GUI Compatibility Aliases - if name ends in LO/HI, also map LOW/HIGH
                    if (roleName.endsWith(' LO')) {
                        boardMap[`${channelId}_alias`] = `${prefix}.${roleName.replace(' LO', ' LOW').replace(/\s+/g, '_')}`;
                    }
                    else if (roleName.endsWith(' HI')) {
                        boardMap[`${channelId}_alias`] = `${prefix}.${roleName.replace(' HI', ' HIGH').replace(/\s+/g, '_')}`;
                    }
                    else if (roleName.endsWith(' DN')) {
                        boardMap[`${channelId}_alias`] = `${prefix}.${roleName.replace(' DN', ' DOWN').replace(/\s+/g, '_')}`;
                    }
                }
                if (Object.keys(boardMap).length === 0) {
                    Object.assign(boardMap, reverseMap);
                }
                boardChannelToEntityMaps.set(boardIp, boardMap);
                console.log(`📋 Loaded sensor role map for board ${boardKey} (${boardIp}):`, boardMap);
            }
        }
    }
    catch (error) {
        console.error('❌ Failed to load sensor_roles from config.toml:', error);
        console.warn('⚠️ No sensor role map available — sensors will appear as unnamed channels');
        channelToEntityMap = {};
    }
    return { channelToEntityMap, boardChannelToEntityMaps };
}
/**
 * Load HP PT board configs from config.toml.
 * Finds every board that declares hp_pt_connectors and builds an HpPtBoardConfig
 * keyed by the board's IP address.
 */
export function loadHpPtConfig() {
    const hpPtBoards = new Map();
    try {
        console.log('📋 Loading HP PT board configuration...');
        const config = readConfig();
        const boards = config.boards || {};
        console.log(`   Found ${Object.keys(boards).length} board(s) in config`);
        const sensorRolesPt2 = config.sensor_roles_pt2 || {};
        console.log(`   Found ${Object.keys(sensorRolesPt2).length} sensor role(s) for pt2`);
        // Build reverse map for pt2: connector_id → entity name
        const pt2ReverseMap = {};
        for (const [roleName, connectorId] of Object.entries(sensorRolesPt2)) {
            if (typeof connectorId === 'number') {
                const entityName = `PT_Cal.${roleName.replace(/\s+/g, '_')}`;
                pt2ReverseMap[connectorId] = entityName;
                console.log(`   Mapping: Connector ${connectorId} (${roleName}) → ${entityName}`);
            }
        }
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw;
            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }
            if (!board.hp_pt_connectors) {
                continue;
            }
            const ip = board.ip;
            console.log(`   🔍 Processing HP PT board: ${boardKey} (${ip})`);
            const hpPtConnectorIds = Array.isArray(board.hp_pt_connectors)
                ? board.hp_pt_connectors
                : [];
            const excitationConnectorId = board.excitation_connector_id ?? -1;
            const fullScalePsi = board.hp_pt_full_scale_psi ?? 5000.0;
            const senseResistorOhms = board.hp_pt_sense_resistor_ohms ?? 240;
            const excitationDividerRatio = board.excitation_divider_attenuation != null
                ? 1 / board.excitation_divider_attenuation
                : (board.excitation_divider_ratio ?? 1.0);
            const adcRefVoltage = board.adc_ref_voltage ?? 2.5;
            const channelToEntity = {};
            for (const connId of hpPtConnectorIds) {
                const entity = pt2ReverseMap[connId] ?? `PT_Cal.HP_PT_${connId}`;
                channelToEntity[connId] = entity;
                console.log(`   HP PT Connector ${connId} → Entity: ${entity}`);
            }
            const hpCfg = {
                boardIp: ip,
                adcRefVoltage,
                hpPtConnectors: new Set(hpPtConnectorIds),
                excitationConnectorId,
                fullScalePsi,
                senseResistorOhms,
                excitationDividerRatio,
                channelToEntity,
            };
            hpPtBoards.set(ip, hpCfg);
            console.log(`📋 Loaded HP PT board config for ${boardKey} (${ip}):`, {
                hpPtConnectors: hpPtConnectorIds,
                excitationConnectorId,
                fullScalePsi,
                senseResistorOhms,
                excitationDividerRatio,
                adcRefVoltage,
                channelToEntity,
            });
            console.log(`   Entity mappings:`, Object.entries(channelToEntity).map(([conn, ent]) => `Connector ${conn} → ${ent}`).join(', '));
        }
        if (hpPtBoards.size === 0) {
            console.log('📋 No HP PT boards configured (no boards with hp_pt_connectors found)');
            console.log('   Checking all boards in config...');
            for (const [boardKey, boardRaw] of Object.entries(boards)) {
                const board = boardRaw;
                console.log(`   - ${boardKey}: ip=${board.ip}, enabled=${board.enabled}, has_hp_pt_connectors=${!!board.hp_pt_connectors}`);
            }
        }
        else {
            console.log(`✅ Loaded ${hpPtBoards.size} HP PT board(s): ${Array.from(hpPtBoards.keys()).join(', ')}`);
        }
    }
    catch (error) {
        console.error('❌ Failed to load HP PT board config from config.toml:', error);
        if (error instanceof Error) {
            console.error('   Error stack:', error.stack);
        }
    }
    return hpPtBoards;
}
/**
 * Load TC board configs from config.toml.
 * Returns a map of board IP → set of active connector IDs (empty set = all connectors).
 */
export function loadTcBoardConfig() {
    const tcBoards = new Map();
    try {
        const config = readConfig();
        const boards = config.boards || {};
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw;
            if (board.type !== 'TC')
                continue;
            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }
            if (!board.ip)
                continue;
            const active = new Set(Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                ? board.active_connectors
                : []);
            tcBoards.set(board.ip, active);
            console.log(`📋 Registered TC board ${boardKey} (${board.ip}), active connectors: ${active.size > 0 ? [...active].join(', ') : 'all'}`);
        }
    }
    catch (error) {
        console.error('❌ Failed to load TC board config from config.toml:', error);
    }
    return tcBoards;
}
/**
 * Load RTD board configs from config.toml.
 * Returns a map of board IP → set of active connector IDs (empty set = all connectors).
 */
export function loadRtdBoardConfig() {
    const rtdBoards = new Map();
    try {
        const config = readConfig();
        const boards = config.boards || {};
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw;
            if (board.type !== 'RTD')
                continue;
            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }
            if (!board.ip)
                continue;
            const active = new Set(Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                ? board.active_connectors
                : []);
            rtdBoards.set(board.ip, active);
            console.log(`📋 Registered RTD board ${boardKey} (${board.ip}), active connectors: ${active.size > 0 ? [...active].join(', ') : 'all'}`);
        }
    }
    catch (error) {
        console.error('❌ Failed to load RTD board config from config.toml:', error);
    }
    return rtdBoards;
}
/**
 * Load LC (Load Cell) board configs from config.toml.
 * Returns a map of board IP → set of active connector IDs (empty set = all connectors).
 */
export function loadLcBoardConfig() {
    const lcBoards = new Map();
    try {
        const config = readConfig();
        const boards = config.boards || {};
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw;
            if (board.type !== 'LC')
                continue;
            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }
            if (!board.ip)
                continue;
            const active = new Set(Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                ? board.active_connectors
                : []);
            lcBoards.set(board.ip, active);
            console.log(`📋 Registered LC board ${boardKey} (${board.ip}), active connectors: ${active.size > 0 ? [...active].join(', ') : 'all'}`);
        }
    }
    catch (error) {
        console.error('❌ Failed to load LC board config from config.toml:', error);
    }
    return lcBoards;
}
/** Pt1000 R0 (Ω) for resistance → temperature conversion */
const PT1000_R0 = 1000;
const PT1000_A = 3.9083e-3;
const PT1000_B = -5.775e-7;
/**
 * Convert Pt1000 resistance (Ω) to temperature (°C). Returns null if out of range.
 * Matches frontend sense-conversions.ts for consistency.
 */
export function pt1000ResistanceToTempC(rOhm) {
    const rr = rOhm / PT1000_R0;
    const d = PT1000_A * PT1000_A - 4 * PT1000_B * (1 - rr);
    if (d < 0)
        return null;
    const sqrtD = Math.sqrt(d);
    const t = (-PT1000_A + sqrtD) / (2 * PT1000_B);
    if (t >= -400 && t <= 1100)
        return t;
    return null;
}
/**
 * Convert raw RTD value to temperature (°C).
 * rawValue is typically ADC counts or milliohms; scale converts to Ohms (default 0.001 = value as milliohms).
 */
export function rawRtdToTemperatureC(rawValue, scaleToOhms = 0.001) {
    const rOhm = rawValue * scaleToOhms;
    return pt1000ResistanceToTempC(rOhm);
}
/**
 * Convert HP PT ADC codes to PSI using the 4-20 mA formula.
 *
 * Both the sensor channel and the excitation channel use the board's fixed
 * adcRefVoltage (2.5 V) as their ADC reference.  The excitation channel
 * reading is used only to verify that excitation is present.
 */
export function convertHpPtToPressure(adcSensor, adcExc, cfg) {
    const ADC_MAX = 2147483648; // 2^31
    const I_MIN_MA = 4.0;
    const I_SPAN_MA = 16.0; // 20 - 4
    if (adcSensor >= ADC_MAX || adcSensor < 0)
        return NaN;
    // adcExc === ADC_MAX is the sentinel for "no excitation connector" (excitation_connector_id = -1).
    // In that case we skip ratiometric compensation and use adcRefVoltage directly.
    if (adcExc === 0 || adcExc === undefined)
        return NaN;
    const vExc = (adcExc / ADC_MAX) * cfg.adcRefVoltage * cfg.excitationDividerRatio;
    void vExc; // available for future ratiometric compensation / logging
    const vSense = (adcSensor / ADC_MAX) * cfg.adcRefVoltage;
    const iMa = (vSense / cfg.senseResistorOhms) * 1000;
    // Treat below-live-zero current as 0 PSI instead of invalid so GUI shows
    // a deterministic pressure value ("0") rather than "---".
    if (iMa < I_MIN_MA)
        return 0.0;
    if (iMa > 20.0)
        return cfg.fullScalePsi;
    const fraction = (iMa - I_MIN_MA) / I_SPAN_MA;
    return fraction * cfg.fullScalePsi;
}
