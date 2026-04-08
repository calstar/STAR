/**
 * Zustand store for sensor system state
 *
 * DATA PLANE: All sensor data uses generic channel-based entity names
 * (PT.CH1, ACT.CH3, TC_Cal.CH5). The database and backend always use these.
 *
 * DISPLAY PLANE: Role names ("Fuel Upstream", "LOX Main") are loaded from
 * /api/config and used only for display labels in the frontend.
 *
 * ALIAS SYSTEM: Components can reference named entities (e.g. PT_Cal.Fuel_Upstream)
 * for readability. The alias system resolves these to generic channel keys at runtime,
 * built dynamically from config.toml sensor_roles / actuator_roles.
 */

import { create } from 'zustand';
import { useCallback, useMemo } from 'react';
import {
  SensorUpdate,
  ActuatorUpdate,
  StateUpdate,
  ConnectionStatus,
  SystemState,
  MissionStartTime,
  BoardStatus,
  ActuatorState,
  NotificationPayload,
  NotificationCategory,
  isNotificationOngoing,
} from './types';
import type { VoltageRefNominals } from './voltageRef';
import { recordSensorUpdate } from './sensor-rate';
interface SensorData {
  [key: string]: number; // entity.component -> value
}

export interface NotificationEntry {
  key?: string;
  category: NotificationCategory;
  message: string;
  timestampMs: number;
  isCurrent: boolean;
}

const NOTIFICATIONS_MAX = 10;

interface SensorSystemState {
  sensorData: SensorData;
  _updateVersion?: number; // Bumps each flush; subscribe via useSensorDataVersion()
  lastSensorFlushMs?: number; // Date.now() at last flush — for latency/freshness display
  actuators: Map<number, ActuatorUpdate>;
  currentState: SystemState | null;
  connectionStatus: ConnectionStatus;
  debugMode: boolean;
  missionStartTime: number | null; // T+0 from first packet (backend)
  /** Global countdown target time (epoch ms), shared across all clients. */
  countdownTargetTimeMs: number | null;
  actuatorExpectedPositions: Record<number, Record<string, 'open' | 'closed' | null>>; // state → entity → position
  /** Global actuator state by entity (updated from backend ACTUATOR_UPDATE and on manual command). */
  actuatorStateByEntity: Record<string, ActuatorState>;
  /** Manual overrides in DEBUG mode; cleared on state change or when leaving DEBUG. */
  actuatorCommandedOverrides: Record<string, ActuatorState>;
  boards: Record<number, BoardStatus>;
  /** From config [adc]; used by sense conversions (TC ref, actuator threshold). */
  voltageRefNominals: VoltageRefNominals;
  /** Load cell zero offsets (lbf) by cal entity e.g. LC_Cal.CH1. Display = raw_lbf - offset. Persisted to localStorage. */
  loadCellZeroOffsets: Record<string, number>;
  notifications: NotificationEntry[];

  updateSensor: (update: SensorUpdate) => void;
  setLoadCellZeroOffset: (calEntity: string, offsetLbf: number | null) => void;
  updateActuator: (update: ActuatorUpdate) => void;
  setActuatorState: (entity: string, state: ActuatorState) => void;
  setActuatorCommandedOverride: (entity: string, state: ActuatorState | null) => void;
  updateState: (update: StateUpdate) => void;
  updateConnectionStatus: (status: ConnectionStatus) => void;
  updateMissionStartTime: (time: number) => void;
  updateCountdownTargetTime: (timeMs: number | null) => void;
  updateActuatorExpectedPositions: (positions: Record<number, Record<string, 'open' | 'closed' | null>>) => void;
  getSensorValue: (entity: string, component: string) => number | null;
  setDebugMode: (mode: boolean) => void;
  updateBoards: (boards: BoardStatus[]) => void;
  setVoltageRefNominals: (nominals: VoltageRefNominals) => void;
  updateNotification: (payload: NotificationPayload) => void;
  clearNotifications: () => void;
}

const LC_ZERO_STORAGE_KEY = 'sensor_system_loadCellZeroOffsets';

function loadStoredLcZeroOffsets(): Record<string, number> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LC_ZERO_STORAGE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, number>;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch (_) { /* ignore */ }
  return {};
}

// ── Dynamic alias system ─────────────────────────────────────────────────────
// Data flows with generic TYPE.CH<n> entity names. Components can still reference
// named entities (e.g. PT_Cal.Fuel_Upstream) — the alias system resolves them
// to the generic channel key at runtime.
//
// Aliases are built dynamically from /api/config (sensor_roles, actuator_roles)
// when the config loads. Static controller aliases are always present.

const STATIC_ALIASES: Record<string, string[]> = {
  // Controller actuation → Fuel/Ox display
  'CONTROLLER.Fuel.duty_cycle': ['CONTROLLER.actuation.duty_F', 'CONTROLLER.fire.duty_F'],
  'CONTROLLER.Fuel.onoff': ['CONTROLLER.actuation.u_F_on', 'CONTROLLER.fire.fire_active'],
  'CONTROLLER.Ox.duty_cycle': ['CONTROLLER.actuation.duty_O', 'CONTROLLER.fire.duty_O'],
  'CONTROLLER.Ox.onoff': ['CONTROLLER.actuation.u_O_on', 'CONTROLLER.fire.fire_active'],
};

// Mutable alias table — starts with statics, gets sensor/actuator aliases added at runtime.
let ALIASES: Record<string, string[]> = { ...STATIC_ALIASES };
// ACT.<Role_Name> -> ACT_CMD.B<board>.CH<channel>
let ACT_ROLE_TO_CMD_ENTITY: Record<string, string> = {};

/**
 * Build aliases from config.toml role mappings.
 * Called when /api/config response arrives.
 *
 * For each role like "Fuel Upstream" = 1 in [sensor_roles_pt_board]:
 *   PT1_Cal.Fuel_Upstream.* → PT1_Cal.CH1.*
 *   PT1.Fuel_Upstream.*     → PT1.CH1.*
 *
 * For actuator_roles like "LOX Main" = ["NC", 1, 12]:
 *   ACT2.LOX_Main.* → ACT2.CH1.*
 */
export function buildAliasesFromConfig(config: any): void {
  const aliases: Record<string, string[]> = { ...STATIC_ALIASES };
  const roleToCmdEntity: Record<string, string> = {};

  const addAlias = (namedKey: string, genericKey: string) => {
    if (!aliases[namedKey]) aliases[namedKey] = [];
    if (!aliases[namedKey].includes(genericKey)) aliases[namedKey].push(genericKey);
  };

  // Common components for different sensor types
  const ptComponents = ['pressure_psi', 'raw_adc_counts', 'raw_adc', 'current_ma', 'sense_voltage', 'excitation_voltage'];
  const tcComponents = ['temperature_c', 'raw_adc_counts', 'raw_adc'];
  const rtdComponents = ['temperature_c', 'raw_resistance_counts', 'raw_resistance'];
  const lcComponents = ['force_kg', 'force_n', 'raw_adc_counts', 'raw_adc'];
  const actComponents = ['raw_adc_counts', 'actuator_state_commanded', 'current_a', 'status'];
  const actCmdComponents = ['actuator_state_commanded'];

  // Helper: add aliases for a sensor role with multiple prefixes and components
  const addSensorAliases = (
    name: string,
    channel: number,
    rawPrefix: string,
    calPrefix: string,
    components: string[],
    addLegacyPtAliases = false
  ) => {
    const entityName = name.replace(/\s+/g, '_');
    const baseRaw = rawPrefix.replace(/\d+$/, '');
    const baseCal = `${baseRaw}_Cal`;
    for (const comp of components) {
      // Board-scoped role and channel aliases (PT1.*, RTD1.*, LC2.*, etc.)
      addAlias(`${calPrefix}.${entityName}.${comp}`, `${calPrefix}.CH${channel}.${comp}`);
      addAlias(`${rawPrefix}.${entityName}.${comp}`, `${rawPrefix}.CH${channel}.${comp}`);
      addAlias(`${baseCal}.CH${channel}.${comp}`, `${calPrefix}.CH${channel}.${comp}`);
      addAlias(`${baseRaw}.CH${channel}.${comp}`, `${rawPrefix}.CH${channel}.${comp}`);
      addAlias(`${baseCal}.${entityName}.${comp}`, `${calPrefix}.CH${channel}.${comp}`);
      addAlias(`${baseRaw}.${entityName}.${comp}`, `${rawPrefix}.CH${channel}.${comp}`);
      // Back-compat: many UI panes still reference PT_Cal.<Role> / PT.<Role>.
      // Map those legacy keys to board-scoped PTn(_Cal).CHm streams.
      if (addLegacyPtAliases) {
        addAlias(`PT_Cal.${entityName}.${comp}`, `${calPrefix}.CH${channel}.${comp}`);
        addAlias(`PT.${entityName}.${comp}`, `${rawPrefix}.CH${channel}.${comp}`);
      }
    }
  };

  const boards = config?.boards || {};

  // Map board keys to their sensor type info
  for (const [boardKey, boardRaw] of Object.entries(boards)) {
    const board = boardRaw as any;
    if (board.enabled === false) continue;
    const type = board.type as string;
    const boardId = typeof board.board_id === 'number' ? board.board_id : 1;
    const mod = boardId % 10;
    const boardNumber = mod === 0 ? 10 : mod;
    const activeChannels: number[] =
      Array.isArray(board.active_connectors) && board.active_connectors.length > 0
        ? board.active_connectors.map((v: unknown) => Number(v)).filter((v: number) => Number.isFinite(v) && v >= 1)
        : Array.from({ length: Math.max(0, Number(board.num_sensors) || 0) }, (_, i) => i + 1);

    // Look for sensor_roles_<boardKey> section in config
    const rolesKey = `sensor_roles_${boardKey}`;
    const roles = config[rolesKey] as Record<string, number> | undefined;

    let rawPrefix = '', calPrefix = '', components: string[] = [];
    if (type === 'PT') { rawPrefix = `PT${boardNumber}`; calPrefix = `PT${boardNumber}_Cal`; components = ptComponents; }
    else if (type === 'TC') { rawPrefix = `TC${boardNumber}`; calPrefix = `TC${boardNumber}_Cal`; components = tcComponents; }
    else if (type === 'RTD') { rawPrefix = `RTD${boardNumber}`; calPrefix = `RTD${boardNumber}_Cal`; components = rtdComponents; }
    else if (type === 'LC') { rawPrefix = `LC${boardNumber}`; calPrefix = `LC${boardNumber}_Cal`; components = lcComponents; }
    else continue;

    // Always add board-level channel aliases so generic keys (e.g. LC_Cal.CH6, RTD.CH1)
    // resolve to board-scoped streams even when sensor_roles_<boardKey> is absent.
    const baseRaw = rawPrefix.replace(/\d+$/, '');
    const baseCal = `${baseRaw}_Cal`;
    for (const ch of activeChannels) {
      for (const comp of components) {
        addAlias(`${baseCal}.CH${ch}.${comp}`, `${calPrefix}.CH${ch}.${comp}`);
        addAlias(`${baseRaw}.CH${ch}.${comp}`, `${rawPrefix}.CH${ch}.${comp}`);
      }
    }

    if (!roles || typeof roles !== 'object') continue;

    for (const [roleName, channelId] of Object.entries(roles)) {
      const ch = typeof channelId === 'number' ? channelId : Number(channelId);
      if (!isFinite(ch)) continue;
      addSensorAliases(roleName, ch, rawPrefix, calPrefix, components, type === 'PT');
    }
  }

  // sensor_roles_pt2 (HP PT — board_id 22 → board_number 2)
  const pt2Roles = config.sensor_roles_pt2 as Record<string, number> | undefined;
  if (pt2Roles && typeof pt2Roles === 'object') {
    for (const [name, connector] of Object.entries(pt2Roles)) {
      const ch = typeof connector === 'number' ? connector : Number(connector);
      if (isFinite(ch)) addSensorAliases(name, ch, 'PT2', 'PT2_Cal', ptComponents, true);
    }
  }

  // Actuator roles — board-namespaced: ACT2.CH1, ACT4.CH3
  const actRoles = config.actuator_roles as Record<string, any> | undefined;
  if (actRoles && typeof actRoles === 'object') {
    for (const [name, value] of Object.entries(actRoles)) {
      const arr = Array.isArray(value) ? value : [];
      if (arr.length < 2) continue;
      const localCh = typeof arr[1] === 'number' ? arr[1] : Number(arr[1]);
      const boardId = arr.length >= 3 && typeof arr[2] === 'number' ? arr[2] : 12;
      const mod = boardId % 10;
      const boardNumber = mod === 0 ? 10 : mod;
      if (!isFinite(localCh) || localCh < 1) continue;
      const entityName = name.replace(/\s+/g, '_');
      const roleEntity = `ACT.${entityName}`;
      roleToCmdEntity[roleEntity] = `ACT_CMD.B${boardNumber}.CH${localCh}`;
      for (const comp of actComponents) {
        addAlias(`ACT${boardNumber}.${entityName}.${comp}`, `ACT${boardNumber}.CH${localCh}.${comp}`);
        // actuators-from-config uses ACT.{Role} and ActuatorControlByName uses ACT_Cal.{Role} for current_a
        addAlias(`ACT.${entityName}.${comp}`, `ACT${boardNumber}.CH${localCh}.${comp}`);
        addAlias(`ACT_Cal.${entityName}.${comp}`, `ACT${boardNumber}_Cal.CH${localCh}.${comp}`);
      }
      for (const comp of actCmdComponents) {
        addAlias(`ACT_CMD.B${boardNumber}.${entityName}.${comp}`, `ACT_CMD.B${boardNumber}.CH${localCh}.${comp}`);
      }
    }
  }

  // Encoder roles — board_id 61 → board_number 1
  const encRoles = config.sensor_roles_encoder_board as Record<string, number> | undefined;
  if (encRoles && typeof encRoles === 'object') {
    for (const [name, ch] of Object.entries(encRoles)) {
      const channel = typeof ch === 'number' ? ch : Number(ch);
      if (!isFinite(channel)) continue;
      const entityName = name.replace(/\s+/g, '_');
      addAlias(`ENC1.${entityName}.raw_angle`, `ENC1.CH${channel}.raw_angle`);
      addAlias(`ENC1_Cal.${entityName}.position_deg`, `ENC1_Cal.CH${channel}.position_deg`);
    }
  }

  ALIASES = aliases;
  ACT_ROLE_TO_CMD_ENTITY = roleToCmdEntity;
  console.log(`[Store] Built ${Object.keys(aliases).length} entity aliases from config`);
}

export { ALIASES };

// ── Batched sensor-data updates ───────────────────────────────────────────────
// Accumulate all incoming sensor writes (including actuator states) and flush
// to Zustand in one batch per animation frame. This prevents dozens of
// synchronous setState calls when a state transition broadcasts 20 actuator
// commanded states at once.
let _pendingSensorWrites: Record<string, number> = {};
let _sensorTimestamps: Record<string, number> = {};
let _flushScheduled = false;
let _updateVersion = 0;

const FLUSH_INTERVAL_MS = 50;

function scheduleSensorFlush(highPriority = false) {
  if (_flushScheduled) return;
  _flushScheduled = true;
  if (highPriority && typeof Promise !== 'undefined') {
    // Microtask: flush at end of current JS task (before next event loop tick).
    // This coalesces multiple actuator_state_commanded writes from one broadcast
    // into a single Zustand setState instead of N separate ones.
    Promise.resolve().then(() => {
      if (_flushScheduled) flushSensorWrites();
    });
  } else if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      if (_flushScheduled) flushSensorWrites();
    });
  } else {
    setTimeout(() => { if (_flushScheduled) flushSensorWrites(); }, FLUSH_INTERVAL_MS);
  }
}

// Safety-net interval: flush any leftover pending writes even if RAF/microtask was skipped.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    if (_flushScheduled || Object.keys(_pendingSensorWrites).length > 0) {
      flushSensorWrites();
    }
  }, FLUSH_INTERVAL_MS);
}

function flushSensorWrites() {
  _flushScheduled = false;
  const batch = _pendingSensorWrites;
  _pendingSensorWrites = {};
  const keys = Object.keys(batch);
  if (keys.length === 0) return;

  _updateVersion++;
  const version = _updateVersion;
  const now = Date.now();
  useSensorStore.setState((state) => {
    const newSensorData: SensorData = { ...state.sensorData };
    for (let i = 0; i < keys.length; i++) {
      newSensorData[keys[i]] = batch[keys[i]];
    }
    return { sensorData: newSensorData, _updateVersion: version, lastSensorFlushMs: now };
  });
}

export const useSensorStore = create<SensorSystemState>((set, get) => ({
  sensorData: {},
  actuators: new Map(),
  currentState: SystemState.IDLE,
  connectionStatus: { connected: false, elodinConnected: false },
  debugMode: false,
  missionStartTime: null,
  countdownTargetTimeMs: null,
  actuatorExpectedPositions: {},
  actuatorStateByEntity: {},
  actuatorCommandedOverrides: {},
  boards: {},
  voltageRefNominals: { internalV: 2.5, absolute5vV: 5 },
  loadCellZeroOffsets: loadStoredLcZeroOffsets(),
  notifications: [],

  setLoadCellZeroOffset: (calEntity: string, offsetLbf: number | null) => {
    set((s) => {
      const next = { ...s.loadCellZeroOffsets };
      if (offsetLbf == null) delete next[calEntity];
      else next[calEntity] = offsetLbf;
      if (typeof localStorage !== 'undefined') {
        try {
          localStorage.setItem(LC_ZERO_STORAGE_KEY, JSON.stringify(next));
        } catch (_) { /* ignore */ }
      }
      return { loadCellZeroOffsets: next };
    });
  },

  updateSensor: (update: SensorUpdate) => {
    recordSensorUpdate(update.entity, update.component);
    const key = `${update.entity}.${update.component}`;

    // Track last timestamp for diagnostics only. Do not drop “older” timestamps: Elodin/WebSocket
    // bursts often deliver calibrated PT rows slightly out of order vs raw; rejecting them left
    // pressure_psi stuck at 0 while raw_adc_counts kept updating.
    _sensorTimestamps[key] = Math.max(_sensorTimestamps[key] || 0, update.timestamp);

    _pendingSensorWrites[key] = update.value;

    if (update.component === 'actuator_state_commanded' || update.component === 'actuator_state') {
      // High-priority: flush via microtask so all actuator writes from a single
      // state-transition broadcast coalesce into one Zustand setState.
      scheduleSensorFlush(true);
      return;
    }

    // Back-compat for legacy LC panes expecting force_lbf / force_n.
    // Backend now publishes canonical force_kg.
    if (update.component === 'force_kg') {
      const lbf = update.value * 2.2046226218;
      const n = update.value * 9.80665;
      const lbfKey = `${update.entity}.force_lbf`;
      const nKey = `${update.entity}.force_n`;
      _sensorTimestamps[lbfKey] = update.timestamp;
      _sensorTimestamps[nKey] = update.timestamp;
      _pendingSensorWrites[lbfKey] = lbf;
      _pendingSensorWrites[nKey] = n;
    }

    scheduleSensorFlush();
  },

  updateActuator: (update: ActuatorUpdate) => {
    const entity = `ACT.${(update.name || '').replace(/\s+/g, '_')}`;
    set((state) => {
      const actuators = new Map(state.actuators);
      if (update.actuatorId != null) actuators.set(update.actuatorId, update);
      return {
        actuators,
        actuatorStateByEntity: { ...state.actuatorStateByEntity, [entity]: update.state },
      };
    });
  },

  setActuatorState: (entity: string, state: ActuatorState) => {
    set((s) => ({ actuatorStateByEntity: { ...s.actuatorStateByEntity, [entity]: state } }));
  },

  setActuatorCommandedOverride: (entity: string, state: ActuatorState | null) => {
    set((s) => {
      const next = { ...s.actuatorCommandedOverrides };
      if (state == null) delete next[entity];
      else next[entity] = state;
      return { actuatorCommandedOverrides: next };
    });
  },

  updateState: (update: StateUpdate) => {
    set((s) => ({
      currentState: update.currentState,
      debugMode: update.debugMode !== undefined ? update.debugMode : get().debugMode,
      actuatorCommandedOverrides: {}, // clear overrides on state change so new state's expected positions apply
    }));
  },

  updateConnectionStatus: (status: ConnectionStatus) => {
    set({ connectionStatus: status });
  },

  updateActuatorExpectedPositions: (positions: Record<number, Record<string, 'open' | 'closed' | null>>) => {
    set((state) => {
      // Deep merge to ensure all state positions are updated
      const updated = { ...state.actuatorExpectedPositions };
      for (const [stateKey, statePositions] of Object.entries(positions)) {
        const stateNum = Number(stateKey);
        updated[stateNum] = { ...(updated[stateNum] || {}), ...statePositions };
      }
      return { actuatorExpectedPositions: updated };
    });
  },

  updateMissionStartTime: (time: number) => {
    set({ missionStartTime: time });
  },

  updateCountdownTargetTime: (timeMs: number | null) => {
    set({ countdownTargetTimeMs: timeMs });
  },

  updateBoards: (boards: BoardStatus[]) => {
    set((state) => {
      const next: Record<number, BoardStatus> = { ...state.boards };
      boards.forEach((b) => {
        next[b.id] = b;
      });
      return { boards: next };
    });
  },

  setVoltageRefNominals: (nominals: VoltageRefNominals) => {
    set({ voltageRefNominals: nominals });
  },

  updateNotification: (payload: NotificationPayload) => {
    set((state) => {
      let list = [...state.notifications];
      if (isNotificationOngoing(payload)) {
        const idx = list.findIndex((n) => n.key === payload.key);
        const entry: NotificationEntry = {
          key: payload.key,
          category: payload.category,
          message: payload.message,
          timestampMs: payload.timestampMs,
          isCurrent: payload.ongoing,
        };
        if (idx >= 0) {
          list[idx] = entry;
        } else if (payload.ongoing) {
          list.unshift(entry);
        } else {
          list = list.map((n) => (n.key === payload.key ? { ...n, isCurrent: false } : n));
        }
      } else {
        list.unshift({
          category: payload.category,
          message: payload.message,
          timestampMs: payload.timestampMs,
          isCurrent: false,
        });
      }
      list = list.slice(0, NOTIFICATIONS_MAX);
      list.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return b.timestampMs - a.timestampMs;
      });
      return { notifications: list };
    });
  },

  clearNotifications: () => {
    set({ notifications: [] });
  },

  getSensorValue: (entity: string, component: string) => {
    const key = `${entity}.${component}`;
    const value = get().sensorData[key];
    if (value !== undefined) return value;

    // Walk alias list
    const fallbacks = ALIASES[key];
    if (fallbacks) {
      for (const fb of fallbacks) {
        const v = get().sensorData[fb];
        if (v !== undefined) return v;
      }
    }

    return null;
  },

  setDebugMode: (mode: boolean) => {
    set((s) => ({ debugMode: mode, actuatorCommandedOverrides: mode ? s.actuatorCommandedOverrides : {} }));
  },
}));

// ── Reactive sensor-value hooks ──────────────────────────────────────────────

export function useSensorValue(entity: string, component: string): number | null {
  const key = `${entity}.${component}`;

  const value = useSensorStore((state) => {
    const direct = state.sensorData[key];
    if (direct !== undefined) return direct;
    const fallbacks = ALIASES[key];
    if (fallbacks) {
      for (const fb of fallbacks) {
        const v = state.sensorData[fb];
        if (v !== undefined) return v;
      }
    }
    return null;
  });

  return value;
}

/** Subscribe to sensor flush tick (10 Hz). Use with useGetSensorValue() so pages that read many values re-render on flush without subscribing to full sensorData. */
export function useSensorDataVersion(): number {
  return useSensorStore((s) => s._updateVersion ?? 0);
}

/** Last flush time (Date.now()). Use to show latency. Frontend flushes every FLUSH_INTERVAL_MS (100ms). */
export function useLastSensorFlushMs(): number | undefined {
  return useSensorStore((s) => s.lastSensorFlushMs);
}

/** Read sensor value at call time; does not subscribe so callers don't re-render on every sensor flush. Use useSensorValue(entity, component) for displayed values, or useSensorDataVersion() + this for pages that show many values. */
export function useGetSensorValue(): (entity: string, component: string) => number | null {
  return useCallback((entity: string, component: string): number | null => {
    const state = useSensorStore.getState();
    const key = `${entity}.${component}`;
    const direct = state.sensorData[key];
    if (direct !== undefined) return direct;
    const fallbacks = ALIASES[key];
    if (fallbacks) {
      for (const fb of fallbacks) {
        const v = state.sensorData[fb];
        if (v !== undefined) return v;
      }
    }
    return null;
  }, []);
}

/**
 * Commanded actuator state from Elodin DB.
 * Reads [0x32] commanded state (binary open/closed from sequencer).
 */
export function useActuatorCommandedState(entity: string): ActuatorState | null {
  const roleMapped = ACT_ROLE_TO_CMD_ENTITY[entity];
  const commanded = useSensorStore((state) => {
    const read = (e: string): number | null => {
      const key = `${e}.actuator_state_commanded`;
      const direct = state.sensorData[key];
      if (direct !== undefined) return direct;
      const fallbacks = ALIASES[key];
      if (fallbacks) {
        for (const fb of fallbacks) {
          const v = state.sensorData[fb];
          if (v !== undefined) return v;
        }
      }
      return null;
    };
    const primary = read(entity);
    if (primary != null) return primary;
    if (roleMapped) {
      const mapped = read(roleMapped);
      if (mapped != null) return mapped;
    }
    return null;
  });

  if (commanded != null && isFinite(commanded)) {
    return commanded === 1 ? ActuatorState.OPEN : ActuatorState.CLOSED;
  }
  return null;
}

/** Global last-known actuator state (from backend or optimistic update). */
export function useActuatorStateByEntity(entity: string): ActuatorState | null {
  return useSensorStore((s) => s.actuatorStateByEntity[entity] ?? null);
}

/** Load cell force (kg) with zero offset applied. Use for display: displayKg = raw - offset. */
export function useLoadCellForceKg(calEntity: string): number | null {
  const raw = useSensorValue(calEntity, 'force_kg');
  const offset = useSensorStore((s) => s.loadCellZeroOffsets[calEntity] ?? 0);
  if (raw == null || !Number.isFinite(raw)) return null;
  return raw - offset;
}

/** @deprecated Use useLoadCellForceKg instead. Legacy alias for backwards compatibility. */
export const useLoadCellForceLbf = useLoadCellForceKg;
