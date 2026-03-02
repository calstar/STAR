/**
 * Sensor configuration loading and HP PT conversion logic.
 * Extracted from server.ts — loadSensorRoleMap, loadHpPtConfig, convertHpPtToPressure.
 */

import { readConfig } from './routes/config.js';
import type { HpPtBoardConfig } from './server-types.js';

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
        const sensorRoles = config.sensor_roles || {};
        const boards = config.boards || {};

        // Build reverse map: channel_id → role_name (for backward compatibility)
        const reverseMap: Record<number, string> = {};
        for (const [roleName, channelId] of Object.entries(sensorRoles)) {
            if (typeof channelId === 'number' && channelId >= 1 && channelId <= 10) {
                const entityName = roleName.replace(/\s+/g, '_');
                reverseMap[channelId] = `PT_Cal.${entityName}`;
            }
        }

        channelToEntityMap = reverseMap;
        console.log(`📋 Loaded sensor role map from config.toml:`, channelToEntityMap);

        // Build board-specific mappings to prevent cross-contamination
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as any;
            if (board.type === 'PT' && board.enabled !== false && board.ip) {
                const boardIp = board.ip as string;
                const isHpBoard = Array.isArray(board.hp_pt_connectors) && board.hp_pt_connectors.length > 0;
                const excitationId = typeof board.excitation_connector_id === 'number' ? board.excitation_connector_id : -1;

                // HP PT board uses sensor_roles_pt2; others use sensor_roles_<boardKey> (e.g. sensor_roles_pt_board)
                const boardSensorRolesKey = isHpBoard ? 'sensor_roles_pt2' : `sensor_roles_${boardKey}`;
                const boardSensorRoles = (config as any)[boardSensorRolesKey] || sensorRoles;

                const boardMap: Record<number, string> = {};
                for (const [roleName, channelId] of Object.entries(boardSensorRoles)) {
                    if (typeof channelId !== 'number' || channelId < 1 || channelId > 10) continue;
                    if (isHpBoard && channelId === excitationId) continue;
                    if (isHpBoard && !(board.hp_pt_connectors as number[]).includes(channelId)) continue;
                    const entityName = roleName.replace(/\s+/g, '_');
                    boardMap[channelId] = `PT_Cal.${entityName}`;
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

    if (iMa < I_MIN_MA) return NaN;
    if (iMa > 20.0) return cfg.fullScalePsi;

    const fraction = (iMa - I_MIN_MA) / I_SPAN_MA;
    return fraction * cfg.fullScalePsi;
}
