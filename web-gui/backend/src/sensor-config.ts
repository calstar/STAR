/**
 * Sensor configuration loading and HP PT conversion logic.
 * Extracted from server.ts — loadSensorRoleMap, loadHpPtConfig, convertHpPtToPressure.
 */

import { readConfig } from './routes/config.js';
import type { HpPtBoardConfig } from './server-types.js';

/**
 * Build actuator channel → entity map from config.toml actuator_roles.
 * Used so Elodin parser uses same names as config (replica of backend/DB).
 */
export function loadActuatorChannelToEntityMap(): Record<number, string> {
    const out: Record<number, string> = {};
    try {
        const config = readConfig();
        const roles = (config.actuator_roles || {}) as Record<string, [string, number] | [string, number, number]>;
        for (const [name, value] of Object.entries(roles)) {
            if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number') {
                const channelId = value[1];
                out[channelId] = `ACT.${name.replace(/\s+/g, '_')}`;
            }
        }
    } catch (_) { /* use empty map */ }
    return out;
}

/**
 * Load sensor_roles from config.toml and build channel ID → entity name maps.
 * Matches combined_gui.py's CONFIG.get_sensor_role() behavior.
 *
 * Returns { channelToEntityMap, boardChannelToEntityMaps }.
 */
export function loadSensorRoleMap(): {
    channelToEntityMap: Record<number, string>;
    boardChannelToEntityMaps: Map<string, Record<number, string>>;
} {
    const boardChannelToEntityMaps = new Map<string, Record<number, string>>();
    let channelToEntityMap: Record<number, string> = {};

    try {
        const config = readConfig();
        // Config has [sensor_roles_pt_board] and [sensor_roles_pt2], NOT [sensor_roles]
        const sensorRolesPtBoard = (config as any).sensor_roles_pt_board || {};
        const sensorRolesPt2 = (config as any).sensor_roles_pt2 || {};
        const boards = config.boards || {};

        // Build reverse map: channel_id → role_name from BOTH PT boards
        const reverseMap: Record<number, string> = {};
        // PT board 1 (sensor_roles_pt_board)
        for (const [roleName, channelId] of Object.entries(sensorRolesPtBoard)) {
            if (typeof channelId === 'number' && channelId >= 1 && channelId <= 10) {
                const entityName = roleName.replace(/\s+/g, '_');
                reverseMap[channelId] = `PT_Cal.${entityName}`;
            }
        }
        // PT board 2 (sensor_roles_pt2) — channels map to 11+ for cross-board uniqueness
        for (const [roleName, channelId] of Object.entries(sensorRolesPt2)) {
            if (typeof channelId === 'number' && channelId >= 1 && channelId <= 10) {
                const entityName = roleName.replace(/\s+/g, '_');
                // PT2 channels are separate board — keep original channel ID but track under board-specific map
                reverseMap[channelId + 10] = `PT_Cal.${entityName}`;
            }
        }

        channelToEntityMap = reverseMap;
        console.log(`📋 Loaded sensor role map from config.toml (${Object.keys(reverseMap).length} channels):`, channelToEntityMap);

        // Build board-specific mappings to prevent cross-contamination
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as any;
            const supportedTypes = ['PT', 'LC', 'RTD', 'TC'];
            if (supportedTypes.includes(board.type) && board.enabled !== false && board.ip) {
                const boardIp = board.ip as string;
                const isHpBoard = Array.isArray(board.hp_pt_connectors) && board.hp_pt_connectors.length > 0;
                const excitationId = typeof board.excitation_connector_id === 'number' ? board.excitation_connector_id : -1;

                // HP PT board uses sensor_roles_pt2; others use sensor_roles_<boardKey> (e.g. sensor_roles_pt_board)
                const boardSensorRolesKey = isHpBoard ? 'sensor_roles_pt2' : `sensor_roles_${boardKey}`;
                const boardSensorRoles = (config as any)[boardSensorRolesKey] || sensorRolesPtBoard;

                const boardMap: Record<string, string> = {};
                for (const [roleName, channelId] of Object.entries(boardSensorRoles)) {
                    if (typeof channelId !== 'number' || channelId < 1 || channelId > 10) continue;
                    if (isHpBoard && channelId === excitationId) continue;
                    if (isHpBoard && !(board.hp_pt_connectors as number[]).includes(channelId)) continue;
                    const entityName = roleName.replace(/\s+/g, '_');
                    const prefix = board.type === 'PT' ? 'PT_Cal' : board.type;
                    const entity = `${prefix}.${entityName}`;
                    boardMap[channelId] = entity;

                    // GUI Compatibility Aliases - if name ends in LO/HI, also map LOW/HIGH
                    if (roleName.endsWith(' LO')) {
                        boardMap[`${channelId}_alias`] = `${prefix}.${roleName.replace(' LO', ' LOW').replace(/\s+/g, '_')}`;
                    } else if (roleName.endsWith(' HI')) {
                        boardMap[`${channelId}_alias`] = `${prefix}.${roleName.replace(' HI', ' HIGH').replace(/\s+/g, '_')}`;
                    } else if (roleName.endsWith(' DN')) {
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
    } catch (error) {
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
export function loadHpPtConfig(): Map<string, HpPtBoardConfig> {
    const hpPtBoards = new Map<string, HpPtBoardConfig>();

    try {
        console.log('📋 Loading HP PT board configuration...');
        const config = readConfig();
        const boards = config.boards || {};
        console.log(`   Found ${Object.keys(boards).length} board(s) in config`);

        const sensorRolesPt2: Record<string, number> = (config.sensor_roles_pt2 as Record<string, number>) || {};
        console.log(`   Found ${Object.keys(sensorRolesPt2).length} sensor role(s) for pt2`);

        // Build reverse map for pt2: connector_id → entity name
        const pt2ReverseMap: Record<number, string> = {};
        for (const [roleName, connectorId] of Object.entries(sensorRolesPt2)) {
            if (typeof connectorId === 'number') {
                const entityName = `PT_Cal.${roleName.replace(/\s+/g, '_')}`;
                pt2ReverseMap[connectorId] = entityName;
                console.log(`   Mapping: Connector ${connectorId} (${roleName}) → ${entityName}`);
            }
        }

        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as Record<string, any>;

            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }

            if (!board.hp_pt_connectors) {
                continue;
            }

            const ip: string = board.ip;
            console.log(`   🔍 Processing HP PT board: ${boardKey} (${ip})`);
            const hpPtConnectorIds: number[] = Array.isArray(board.hp_pt_connectors)
                ? board.hp_pt_connectors
                : [];
            const excitationConnectorId: number = board.excitation_connector_id ?? -1;
            const fullScalePsi: number = board.hp_pt_full_scale_psi ?? 5000.0;
            const senseResistorOhms: number = board.hp_pt_sense_resistor_ohms ?? 240;
            const excitationDividerRatio: number =
                board.excitation_divider_attenuation != null
                    ? 1 / board.excitation_divider_attenuation
                    : (board.excitation_divider_ratio ?? 1.0);
            const adcRefVoltage: number = board.adc_ref_voltage ?? 2.5;

            const channelToEntity: Record<number, string> = {};
            for (const connId of hpPtConnectorIds) {
                const entity = pt2ReverseMap[connId] ?? `PT_Cal.HP_PT_${connId}`;
                channelToEntity[connId] = entity;
                console.log(`   HP PT Connector ${connId} → Entity: ${entity}`);
            }

            const hpCfg: HpPtBoardConfig = {
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
                const board = boardRaw as Record<string, any>;
                console.log(`   - ${boardKey}: ip=${board.ip}, enabled=${board.enabled}, has_hp_pt_connectors=${!!board.hp_pt_connectors}`);
            }
        } else {
            console.log(`✅ Loaded ${hpPtBoards.size} HP PT board(s): ${Array.from(hpPtBoards.keys()).join(', ')}`);
        }
    } catch (error) {
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
export function loadTcBoardConfig(): Map<string, Set<number>> {
    const tcBoards = new Map<string, Set<number>>();

    try {
        const config = readConfig();
        const boards = config.boards || {};

        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as any;
            if (board.type !== 'TC') continue;
            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }
            if (!board.ip) continue;

            const active: Set<number> = new Set(
                Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                    ? (board.active_connectors as number[])
                    : []
            );
            tcBoards.set(board.ip, active);
            console.log(`📋 Registered TC board ${boardKey} (${board.ip}), active connectors: ${active.size > 0 ? [...active].join(', ') : 'all'}`);
        }
    } catch (error) {
        console.error('❌ Failed to load TC board config from config.toml:', error);
    }

    return tcBoards;
}

/**
 * Load RTD board configs from config.toml.
 * Returns a map of board IP → set of active connector IDs (empty set = all connectors).
 */
export function loadRtdBoardConfig(): Map<string, Set<number>> {
    const rtdBoards = new Map<string, Set<number>>();

    try {
        const config = readConfig();
        const boards = config.boards || {};

        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as any;
            if (board.type !== 'RTD') continue;
            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }
            if (!board.ip) continue;

            const active: Set<number> = new Set(
                Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                    ? (board.active_connectors as number[])
                    : []
            );
            rtdBoards.set(board.ip, active);
            console.log(`📋 Registered RTD board ${boardKey} (${board.ip}), active connectors: ${active.size > 0 ? [...active].join(', ') : 'all'}`);
        }
    } catch (error) {
        console.error('❌ Failed to load RTD board config from config.toml:', error);
    }

    return rtdBoards;
}

/**
 * Load LC (Load Cell) board configs from config.toml.
 * Returns a map of board IP → set of active connector IDs (empty set = all connectors).
 */
export function loadLcBoardConfig(): Map<string, Set<number>> {
    const lcBoards = new Map<string, Set<number>>();

    try {
        const config = readConfig();
        const boards = config.boards || {};

        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as any;
            if (board.type !== 'LC') continue;
            if (board.enabled === false) {
                console.log(`   ⏭️  Skipping ${boardKey} (${board.ip}): board is disabled`);
                continue;
            }
            if (!board.ip) continue;

            const active: Set<number> = new Set(
                Array.isArray(board.active_connectors) && board.active_connectors.length > 0
                    ? (board.active_connectors as number[])
                    : []
            );
            lcBoards.set(board.ip, active);
            console.log(`📋 Registered LC board ${boardKey} (${board.ip}), active connectors: ${active.size > 0 ? [...active].join(', ') : 'all'}`);
        }
    } catch (error) {
        console.error('❌ Failed to load LC board config from config.toml:', error);
    }

    return lcBoards;
}

/** Pt100 R0 (Ω) for resistance → temperature conversion */
const PT100_R0 = 100;
const PT100_A = 3.9083e-3;
const PT100_B = -5.775e-7;

/**
 * Convert Pt100 resistance (Ω) to temperature (°C). Returns null if out of range.
 * Matches frontend sense-conversions.ts for consistency.
 */
export function pt100ResistanceToTempC(rOhm: number): number | null {
    const rr = rOhm / PT100_R0;
    const d = PT100_A * PT100_A - 4 * PT100_B * (1 - rr);
    if (d < 0) return null;
    const sqrtD = Math.sqrt(d);
    const t = (-PT100_A + sqrtD) / (2 * PT100_B);
    if (t >= -400 && t <= 1100) return t;
    return null;
}

/**
 * Convert raw RTD value to temperature (°C).
 * rawValue is typically ADC counts or milliohms; scale converts to Ohms (default 0.001 = value as milliohms).
 */
export function rawRtdToTemperatureC(rawValue: number, scaleToOhms: number = 0.001): number | null {
    const rOhm = rawValue * scaleToOhms;
    return pt100ResistanceToTempC(rOhm);
}

/**
 * Convert HP PT ADC codes to PSI using the 4-20 mA formula.
 *
 * Both the sensor channel and the excitation channel use the board's fixed
 * adcRefVoltage (2.5 V) as their ADC reference.  The excitation channel
 * reading is used only to verify that excitation is present.
 */
export function convertHpPtToPressure(
    adcSensor: number,
    adcExc: number,
    cfg: HpPtBoardConfig,
): number {
    const ADC_MAX = 2147483648; // 2^31
    const I_MIN_MA = 4.0;
    const I_SPAN_MA = 16.0; // 20 - 4

    if (adcSensor > 2147483647) return NaN;
    if (adcSensor < 0) return NaN;
    if (adcExc === 0 || adcExc === undefined) return NaN;
    if (adcExc > 2147483647) return NaN;

    const vExc = (adcExc / ADC_MAX) * cfg.adcRefVoltage * cfg.excitationDividerRatio;
    void vExc; // available for future ratiometric compensation / logging

    const vSense = (adcSensor / ADC_MAX) * cfg.adcRefVoltage;
    const iMa = (vSense / cfg.senseResistorOhms) * 1000;

    // Treat below-live-zero current as 0 PSI instead of invalid so GUI shows
    // a deterministic pressure value ("0") rather than "---".
    if (iMa < I_MIN_MA) return 0.0;
    if (iMa > 20.0) return cfg.fullScalePsi;

    const fraction = (iMa - I_MIN_MA) / I_SPAN_MA;
    return fraction * cfg.fullScalePsi;
}
