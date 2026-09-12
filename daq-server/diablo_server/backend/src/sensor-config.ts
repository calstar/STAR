/**
 * Sensor configuration loading and HP PT conversion logic.
 * Extracted from server.ts — loadSensorRoleMap and the per-board sensor role maps.
 */

import { readConfig } from './routes/config.js';

let warnedLegacyPtType = false;

/**
 * True when a PT board's sensors are 4-20 mA current-loop transmitters.
 *
 * `pt_type` is authoritative and matches what the C++ calibration service reads, so there is
 * one source of truth and no positional "slot 2 is HP" assumption. A board that predates
 * `pt_type` is still recognised from its legacy hp_pt_* keys so a deployed config or a saved
 * profile keeps working.
 */
export function isCurrentLoopBoard(board: any): boolean {
    if (typeof board?.pt_type === 'string') return board.pt_type === '4-20 mA absolute';
    const legacy = (Array.isArray(board?.hp_pt_connectors) && board.hp_pt_connectors.length > 0)
        || typeof board?.hp_pt_full_scale_psi === 'number';
    if (legacy && !warnedLegacyPtType) {
        warnedLegacyPtType = true;
        console.warn('⚠️  Board has no pt_type; inferring "4-20 mA absolute" from its hp_pt_* keys. Add pt_type to the board.');
    }
    return legacy;
}

/**
 * Board-numbers (board_id % 10, with 0→10) of the PT boards that are high-pressure
 * 4-20 mA current-loop boards. Used by the Elodin decoder to pick unsigned-vs-signed raw-ADC
 * interpretation and by the GUI to label HP boards. `config` is optional so callers on the hot
 * path can pass a cached config.
 */
export function hpBoardNumbers(config?: any): Set<number> {
    const out = new Set<number>();
    try {
        const cfg = config ?? readConfig();
        const boards = (cfg.boards || {}) as Record<string, any>;
        for (const board of Object.values(boards)) {
            if (!isCurrentLoopBoard(board) || typeof board?.board_id !== 'number') continue;
            const mod = board.board_id % 10;
            out.add(mod === 0 ? 10 : mod);
        }
    } catch { /* empty set on config error */ }
    return out;
}

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
                const localChannel = value[1];
                const boardId = (value.length >= 3 && typeof value[2] === 'number') ? value[2] : 11;
                // Per-board channel mapping (for [0x30], [0x31] — DAQ bridge resolves by source IP)
                out[localChannel] = `ACT.${name.replace(/\s+/g, '_')}`;
                // Global channel mapping (for [0x32] — sequencer publishes with global IDs)
                const globalChannel = (boardId - 11) * 10 + localChannel;
                out[globalChannel] = `ACT.${name.replace(/\s+/g, '_')}`;
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
        const boards = config.boards || {};

        // Build reverse map: (connector + (boardNumber-1)*10) → PT_Cal.<role>, iterating every
        // PT board's own [sensor_roles_<boardKey>] section. The per-board offset (board 1 → +0,
        // board 2 → +10, board 3 → +20, …) keeps roles from different PT boards from colliding in
        // this flat legacy map; boardNumber = board_id % 10 (0→10), matching the packet-ID scheme.
        // (Previously hardcoded to sensor_roles_pt_board + a fixed +10 on sensor_roles_pt2.)
        const reverseMap: Record<number, string> = {};
        for (const [boardKey, boardRaw] of Object.entries(boards)) {
            const board = boardRaw as any;
            if (board.type !== 'PT' || typeof board.board_id !== 'number') continue;
            const mod = board.board_id % 10;
            const boardNumber = mod === 0 ? 10 : mod;
            const roles = (config as any)[`sensor_roles_${boardKey}`] || {};
            for (const [roleName, channelId] of Object.entries(roles)) {
                if (typeof channelId === 'number' && channelId >= 1 && channelId <= 10) {
                    reverseMap[channelId + (boardNumber - 1) * 10] = `PT_Cal.${roleName.replace(/\s+/g, '_')}`;
                }
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

                // Every board reads its own [sensor_roles_<boardKey>] section — HP boards included
                // (no special sensor_roles_pt2 section anymore).
                const boardSensorRoles = (config as any)[`sensor_roles_${boardKey}`] || {};

                const boardMap: Record<string, string> = {};
                for (const [roleName, channelId] of Object.entries(boardSensorRoles)) {
                    if (typeof channelId !== 'number' || channelId < 1 || channelId > 10) continue;
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

/** Pt1000 R0 (Ω) for resistance → temperature conversion */
const PT1000_R0 = 1000;
const PT1000_A = 3.9083e-3;
const PT1000_B = -5.775e-7;

/**
 * Convert Pt1000 resistance (Ω) to temperature (°C). Returns null if out of range.
 * Matches frontend sense-conversions.ts for consistency.
 */
export function pt1000ResistanceToTempC(rOhm: number): number | null {
    const rr = rOhm / PT1000_R0;
    const d = PT1000_A * PT1000_A - 4 * PT1000_B * (1 - rr);
    if (d < 0) return null;
    const sqrtD = Math.sqrt(d);
    const t = (-PT1000_A + sqrtD) / (2 * PT1000_B);
    if (t >= -400 && t <= 1100) return t;
    return null;
}

/**
 * Convert raw RTD value to temperature (°C).
 * rawValue is typically ADC counts or milliohms; scale converts to Ohms (default 0.001 = value as milliohms).
 */
export function rawRtdToTemperatureC(rawValue: number, scaleToOhms: number = 0.001): number | null {
    const rOhm = rawValue * scaleToOhms;
    return pt1000ResistanceToTempC(rOhm);
}


