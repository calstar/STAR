/**
 * Sensor configuration loading and HP PT conversion logic.
 * Extracted from server.ts — loadSensorRoleMap and the per-board sensor role maps.
 */

import { readConfig } from './routes/config.js';
import { t7Channels } from '../../shared/config-validation.js';

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
 * The Elodin board slot ("board number") of a board id: `board_id % 10`, with 0 → 10.
 *
 * One home for the rule every per-board map used to compute inline (the packet-ID scheme, the
 * sensor role maps, the registry's subscription list, the state-CSV actuator resolution). No
 * validation: callers keep their own guards (`-21 → -1`, `21.5 → 1.5`, `NaN → NaN`, exactly as
 * each copy computed). The registry's `% 8` fold stays where it is, in `elodin-vtable-registry.ts`.
 */
export function boardSlot(boardId: number): number {
    const m = boardId % 10;
    return m === 0 ? 10 : m;
}

/**
 * Board-numbers (board_id % 10, with 0→10) of the PT boards that are high-pressure
 * 4-20 mA current-loop boards. Used by the Elodin decoder to pick unsigned-vs-signed raw-ADC
 * interpretation and by the GUI to label HP boards. `config` is optional so callers on the hot
 * path can pass a cached config.
 */
/**
 * LabJack T7 calibrated tables (low byte of {0x26, low}) -> the field each carries, for the
 * decoder (parseElodinPacket's t7CalFields). Enabled boards only, from the deployed config.
 */
export function t7CalFields(config?: any): Map<number, string> {
    const out = new Map<number, string>();
    try {
        const cfg = config ?? readConfig();
        for (const ch of t7Channels(cfg.boards))
            if (ch.enabled && ch.calLow !== null && ch.calField) out.set(ch.calLow, ch.calField);
    } catch {
        // No config: no T7 tables are decoded, the same as no T7.
    }
    return out;
}

export function hpBoardNumbers(config?: any): Set<number> {
    const out = new Set<number>();
    try {
        const cfg = config ?? readConfig();
        const boards = (cfg.boards || {}) as Record<string, any>;
        for (const board of Object.values(boards)) {
            if (!isCurrentLoopBoard(board) || typeof board?.board_id !== 'number') continue;
            out.add(boardSlot(board.board_id));
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
            const boardNumber = boardSlot(board.board_id);
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



// ── Sensor config helpers ──────────────────────────────────────────────────

export interface SensorConfigEntry {
  /** Sensor kind — the field buildSensorConfig() previously left the caller to infer (or not). */
  type: 'PT' | 'TC' | 'RTD' | 'LC';
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
  /** 'T7' for a LabJack T7 channel (t7_bridge): `id` is then its AIN number and the entities are
   *  T7<slot>.AIN<n> / T7<slot>_Cal.AIN<n>. Absent for the ESP32 boards. */
  source?: 'T7';
}

/**
 * How many enabled boards of this type the rig has.
 *
 * A generated role name ("LC Ch1") says nothing about which board it came from, and two
 * boards of one type routinely declare the same connector — two LC boards each reporting
 * on channel 1. The calibration page and the GUI list these names, so with a twin present
 * the name has to carry the board_id or the operator is picking blind.
 */
function enabledBoardCount(boards: Record<string, any>, type: string): number {
  return Object.values(boards).filter((b: any) => b?.type === type && b?.enabled !== false).length;
}

/** Generated role for a board with no [sensor_roles_<board>] section. */
function generatedRole(type: string, boardId: number, ch: number, multiBoard: boolean): string {
  return multiBoard ? `${type}${boardId} Ch${ch}` : `${type} Ch${ch}`;
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

/** `/api/sensor-config`. Exported, with an injectable config, for the tests. */
export function buildSensorConfig(config: any = readConfig()): SensorConfigEntry[] {
  const boards = (config.boards || {}) as Record<string, any>;
  const sensors: SensorConfigEntry[] = [];

  const manyPtBoards = enabledBoardCount(boards, 'PT') > 1;
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
    const named = new Set<number>();
    for (const [roleName, channelIdRaw] of Object.entries(rolesSection)) {
      const channelId = typeof channelIdRaw === 'number' ? channelIdRaw : Number(channelIdRaw);
      if (!isFinite(channelId)) continue;

      const isHpPt = isHpBoard;
      const boardNumber = elodinSlotFromBoardId(boardId);

      sensors.push({
        type: 'PT',
        id: channelId,
        role: roleName,
        boardId,
        boardIp,
        isHpPt,
        inCalibrationSequence: true,
        entity: `PT${boardNumber}.CH${channelId}`,
        calEntity: `PT${boardNumber}_Cal.CH${channelId}`,
      });
      named.add(channelId);
    }

    // A connector in active_connectors that no role names is still sampled and streamed (the
    // board sends every active connector), so list it under a generated name, as RTD and LC
    // boards do. Without this the Sensor Info tab showed only named PTs and an unnamed but
    // active channel was invisible. It stays out of the calibration sequence: with no role it
    // has no [calibration_model_<board>] entry for a fit to apply to.
    const active: number[] = Array.isArray(board.active_connectors) ? board.active_connectors : [];
    for (const raw of active) {
      const ch = typeof raw === 'number' ? raw : Number(raw);
      if (!isFinite(ch) || named.has(ch)) continue;
      named.add(ch);
      const boardNumber = elodinSlotFromBoardId(boardId);
      sensors.push({
        type: 'PT',
        id: ch,
        role: generatedRole('PT', boardId, ch, manyPtBoards),
        boardId,
        boardIp,
        isHpPt: isHpBoard,
        inCalibrationSequence: false,
        entity: `PT${boardNumber}.CH${ch}`,
        calEntity: `PT${boardNumber}_Cal.CH${ch}`,
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
        type: 'TC',
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

  const manyRtdBoards = enabledBoardCount(boards, 'RTD') > 1;
  // RTD boards: sensor_roles_<boardKey> or active_connectors with role "RTD ChN"
  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as Record<string, any>;
    if (board.type !== 'RTD') continue;
    if (board.enabled === false) continue;

    const boardId = asBoardId(board.board_id, 31);
    const boardIp: string = board.ip || '';
    const boardRolesKey = `sensor_roles_${boardKey}`;
    const rolesSection = (config as any)[boardRolesKey] as Record<string, number> | undefined;
    const active: number[] = Array.isArray(board.active_connectors) ? (board.active_connectors as number[]) : [];

    const boardNumber = elodinSlotFromBoardId(boardId);
    if (rolesSection && typeof rolesSection === 'object') {
      for (const [roleName, channelId] of Object.entries(rolesSection)) {
        const ch = typeof channelId === 'number' ? channelId : Number(channelId);
        if (!isFinite(ch)) continue;
        sensors.push({
          type: 'RTD',
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
          type: 'RTD',
          id: ch,
          role: generatedRole('RTD', boardId, ch, manyRtdBoards),
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

  const manyLcBoards = enabledBoardCount(boards, 'LC') > 1;
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
          type: 'LC',
          id: ch,
          role: roleName,
          boardId,
          boardIp,
          isHpPt: false,
          inCalibrationSequence: true,
          entity: `LC${boardNumber}.CH${ch}`,
          calEntity: `LC${boardNumber}_Cal.CH${ch}`,
        });
      }
    } else {
      const active: number[] = Array.isArray(board.active_connectors) ? (board.active_connectors as number[]) : [];
      for (const ch of active) {
        sensors.push({
          type: 'LC',
          id: ch,
          role: generatedRole('LC', boardId, ch, manyLcBoards),
          boardId,
          boardIp,
          isHpPt: false,
          inCalibrationSequence: true,
          entity: `LC${boardNumber}.CH${ch}`,
          calEntity: `LC${boardNumber}_Cal.CH${ch}`,
        });
      }
    }
  }

  // LabJack T7 channels: one more PT / TC / LC / RTD each, named by their role, in the same units, and
  // calibrated by calibration_service exactly like an ESP32 PT / LC (uid board_id*100 + AIN), so
  // PT and LC inputs take part in the calibration sequence as the ESP32 ones do.
  for (const ch of t7Channels(boards)) {
    if (!ch.enabled || ch.calEntity === null) continue;
    if (ch.kind !== 'PT' && ch.kind !== 'TC' && ch.kind !== 'LC' && ch.kind !== 'RTD') continue;
    sensors.push({
      type: ch.kind,
      id: ch.ain,
      role: ch.role,
      boardId: ch.boardId,
      boardIp: ch.boardIp,
      isHpPt: false,
      inCalibrationSequence: ch.kind === 'PT' || ch.kind === 'LC',
      entity: ch.entity,
      calEntity: ch.calEntity,
      source: 'T7',
    });
  }

  // Sort: board order first, then channel id within board
  sensors.sort((a, b) => {
    if (a.boardId !== b.boardId) return a.boardId - b.boardId;
    return a.id - b.id;
  });

  return sensors;
}
