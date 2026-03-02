/**
 * Zustand store for sensor system state
 *
 * ENTITY NAME ALIASES
 * The backend can run in two modes:
 *  1. Direct-DAQ mode → emits named entities  e.g. PT_Cal.Fuel_Upstream.pressure_psi
 *  2. Elodin-DB mode  → emits channel entities e.g. PT_Cal.PT_CH1.pressure_psi
 *
 * Sensor-role → channel mapping (from config.toml):
 *   Fuel Upstream = CH1, GSE Low = CH2, Fuel Downstream = CH4, ...; GSE Mid = board 2 connector 4
 *   Ox Upstream   = CH5, GN2 Regulated = CH6, Ox Downstream = CH7
 *
 * Actuator-role → channel mapping (from config.toml actuator_roles):
 *   LOX Main = CH1, Fuel Vent = CH2, Fuel Press = CH3, GSE Low Vent = CH5
 *   LOX Vent = CH6, Fuel Main  = CH7, LOX Press  = CH8
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

const NOTIFICATIONS_MAX = 100;

interface SensorSystemState {
  sensorData: SensorData;
  _updateVersion?: number; // Internal version counter to force re-renders
  actuators: Map<number, ActuatorUpdate>;
  currentState: SystemState | null;
  connectionStatus: ConnectionStatus;
  debugMode: boolean;
  missionStartTime: number | null; // T+0 from first packet (backend)
  actuatorExpectedPositions: Record<number, Record<string, 'open' | 'closed' | null>>; // state → entity → position
  /** Global actuator state by entity (updated from backend ACTUATOR_UPDATE and on manual command). */
  actuatorStateByEntity: Record<string, ActuatorState>;
  /** Manual overrides in DEBUG mode; cleared on state change or when leaving DEBUG. */
  actuatorCommandedOverrides: Record<string, ActuatorState>;
  boards: Record<number, BoardStatus>;
  notifications: NotificationEntry[];

  updateSensor: (update: SensorUpdate) => void;
  updateActuator: (update: ActuatorUpdate) => void;
  setActuatorState: (entity: string, state: ActuatorState) => void;
  setActuatorCommandedOverride: (entity: string, state: ActuatorState | null) => void;
  updateState: (update: StateUpdate) => void;
  updateConnectionStatus: (status: ConnectionStatus) => void;
  updateMissionStartTime: (time: number) => void;
  updateActuatorExpectedPositions: (positions: Record<number, Record<string, 'open' | 'closed' | null>>) => void;
  getSensorValue: (entity: string, component: string) => number | null;
  setDebugMode: (mode: boolean) => void;
  updateBoards: (boards: BoardStatus[]) => void;
  updateNotification: (payload: NotificationPayload) => void;
}

// ── Alias table ──────────────────────────────────────────────────────────────
// Maps lookup key → list of fallback keys to try in order.
const ALIASES: Record<string, string[]> = {
  // ── PT calibrated pressure (named → PT_CHX) ─────────────────────────────
  'PT_Cal.Fuel_Upstream.pressure_psi': ['PT_Cal.PT_CH1.pressure_psi', 'PT.Fuel_Upstream.pressure_psi', 'PT.PT_CH1.pressure_psi'],
  'PT_Cal.GSE_Low.pressure_psi': ['PT_Cal.PT_CH2.pressure_psi', 'PT.GSE_Low.pressure_psi', 'PT.PT_CH2.pressure_psi'],
  'PT_Cal.GSE_Mid.pressure_psi': ['PT_Cal.HP_PT_1.pressure_psi', 'PT.GSE_Mid.pressure_psi'],
  'PT_Cal.HP_PT_1.pressure_psi': ['PT_Cal.GSE_Mid.pressure_psi', 'PT.GSE_Mid.pressure_psi'],
  'PT_Cal.Fuel_Downstream.pressure_psi': ['PT_Cal.PT_CH3.pressure_psi', 'PT.Fuel_Downstream.pressure_psi', 'PT.PT_CH3.pressure_psi'],
  'PT_Cal.Fuel_Fill_Tank.pressure_psi': ['PT_Cal.PT_CH4.pressure_psi', 'PT.Fuel_Fill_Tank.pressure_psi', 'PT.PT_CH4.pressure_psi'],
  'PT_Cal.Ox_Upstream.pressure_psi': ['PT_Cal.PT_CH5.pressure_psi', 'PT.Ox_Upstream.pressure_psi', 'PT.PT_CH5.pressure_psi'],
  'PT_Cal.GN2_Regulated.pressure_psi': ['PT_Cal.PT_CH6.pressure_psi', 'PT.GN2_Regulated.pressure_psi', 'PT.PT_CH6.pressure_psi'],
  'PT_Cal.Ox_Downstream.pressure_psi': ['PT_Cal.PT_CH7.pressure_psi', 'PT.Ox_Downstream.pressure_psi', 'PT.PT_CH7.pressure_psi'],
  'PT_Cal.GSE_High.pressure_psi': ['PT_Cal.HP_PT_3.pressure_psi', 'PT_Cal.PT_CH8.pressure_psi', 'PT.PT_CH8.pressure_psi'],
  'PT_Cal.HP_PT_3.pressure_psi': ['PT_Cal.GSE_High.pressure_psi', 'PT.PT_CH8.pressure_psi'],
  'PT_Cal.GN2_High.pressure_psi': ['PT_Cal.HP_PT_4.pressure_psi', 'PT_Cal.PT_CH9.pressure_psi', 'PT_Cal.PT_CH10.pressure_psi', 'PT.PT_CH9.pressure_psi', 'PT.PT_CH10.pressure_psi'],
  'PT_Cal.HP_PT_4.pressure_psi': ['PT_Cal.GN2_High.pressure_psi', 'PT.PT_CH9.pressure_psi', 'PT.PT_CH10.pressure_psi'],

  // ── PT raw ADC counts (named → PT_CHX) ──────────────────────────────────
  'PT_Cal.Fuel_Upstream.raw_adc_counts': ['PT_Cal.PT_CH1.raw_adc_counts', 'PT.Fuel_Upstream.raw_adc_counts', 'PT.PT_CH1.raw_adc_counts'],
  'PT_Cal.GSE_Low.raw_adc_counts': ['PT_Cal.PT_CH2.raw_adc_counts', 'PT.PT_CH2.raw_adc_counts'],
  'PT_Cal.GSE_Mid.raw_adc_counts': ['PT_Cal.HP_PT_1.raw_adc_counts', 'PT.GSE_Mid.raw_adc_counts'],
  'PT_Cal.HP_PT_1.raw_adc_counts': ['PT_Cal.GSE_Mid.raw_adc_counts'],
  'PT_Cal.PT_CH3.raw_adc_counts': ['PT.PT_CH3.raw_adc_counts'],
  'PT_Cal.Fuel_Downstream.raw_adc_counts': ['PT_Cal.PT_CH3.raw_adc_counts', 'PT.PT_CH3.raw_adc_counts'],
  'PT_Cal.Fuel_Fill_Tank.raw_adc_counts': ['PT_Cal.PT_CH4.raw_adc_counts', 'PT.PT_CH4.raw_adc_counts'],
  'PT_Cal.Ox_Upstream.raw_adc_counts': ['PT_Cal.PT_CH5.raw_adc_counts', 'PT.PT_CH5.raw_adc_counts'],
  'PT_Cal.GN2_Regulated.raw_adc_counts': ['PT_Cal.PT_CH6.raw_adc_counts', 'PT.PT_CH6.raw_adc_counts'],
  'PT_Cal.Ox_Downstream.raw_adc_counts': ['PT_Cal.PT_CH7.raw_adc_counts', 'PT.PT_CH7.raw_adc_counts'],
  'PT_Cal.GSE_High.raw_adc_counts': ['PT_Cal.HP_PT_3.raw_adc_counts', 'PT_Cal.PT_CH8.raw_adc_counts', 'PT.PT_CH8.raw_adc_counts'],
  'PT_Cal.HP_PT_3.raw_adc_counts': ['PT_Cal.GSE_High.raw_adc_counts', 'PT.PT_CH8.raw_adc_counts'],
  'PT_Cal.GN2_High.raw_adc_counts': ['PT_Cal.HP_PT_4.raw_adc_counts', 'PT_Cal.PT_CH9.raw_adc_counts', 'PT_Cal.PT_CH10.raw_adc_counts', 'PT.PT_CH9.raw_adc_counts', 'PT.PT_CH10.raw_adc_counts'],
  'PT_Cal.HP_PT_4.raw_adc_counts': ['PT_Cal.GN2_High.raw_adc_counts', 'PT.PT_CH9.raw_adc_counts', 'PT.PT_CH10.raw_adc_counts'],

  // ── PT raw (PT. namespace) → PT_Cal namespace fallback ──────────────────
  'PT.PT_CH1.raw_adc_counts': ['PT_Cal.PT_CH1.raw_adc_counts', 'PT.Fuel_Upstream.raw_adc_counts'],
  'PT.PT_CH2.raw_adc_counts': ['PT_Cal.PT_CH2.raw_adc_counts', 'PT.GSE_Low.raw_adc_counts'],
  'PT.PT_CH3.raw_adc_counts': ['PT_Cal.PT_CH3.raw_adc_counts', 'PT.Fuel_Downstream.raw_adc_counts'],
  'PT.PT_CH4.raw_adc_counts': ['PT_Cal.PT_CH4.raw_adc_counts', 'PT.Fuel_Fill_Tank.raw_adc_counts'],
  'PT.PT_CH5.raw_adc_counts': ['PT_Cal.PT_CH5.raw_adc_counts', 'PT.Ox_Upstream.raw_adc_counts'],
  'PT.PT_CH6.raw_adc_counts': ['PT_Cal.PT_CH6.raw_adc_counts', 'PT.GN2_Regulated.raw_adc_counts'],
  'PT.PT_CH7.raw_adc_counts': ['PT_Cal.PT_CH7.raw_adc_counts', 'PT.Ox_Downstream.raw_adc_counts'],
  'PT.PT_CH8.raw_adc_counts': ['PT_Cal.PT_CH8.raw_adc_counts'],
  'PT.PT_CH9.raw_adc_counts': ['PT_Cal.PT_CH9.raw_adc_counts'],
  'PT.PT_CH10.raw_adc_counts': ['PT_Cal.PT_CH10.raw_adc_counts'],

  // ── Actuator named → ACT_CHX (from config.toml actuator_roles) ──────────
  'ACT.LOX_Main.raw_adc_counts': ['ACT.ACT_CH1.raw_adc_counts'],
  'ACT.LOX_Main.status': ['ACT.ACT_CH1.status'],
  'ACT.Fuel_Vent.raw_adc_counts': ['ACT.ACT_CH2.raw_adc_counts'],
  'ACT.Fuel_Vent.status': ['ACT.ACT_CH2.status'],
  'ACT.Fuel_Press.raw_adc_counts': ['ACT.ACT_CH3.raw_adc_counts'],
  'ACT.Fuel_Press.status': ['ACT.ACT_CH3.status'],
  'ACT.GSE_Low_Vent.raw_adc_counts': ['ACT.ACT_CH5.raw_adc_counts'],
  'ACT.GSE_Low_Vent.status': ['ACT.ACT_CH5.status'],
  'ACT.LOX_Vent.raw_adc_counts': ['ACT.ACT_CH6.raw_adc_counts'],
  'ACT.LOX_Vent.status': ['ACT.ACT_CH6.status'],
  'ACT.Fuel_Main.raw_adc_counts': ['ACT.ACT_CH7.raw_adc_counts'],
  'ACT.Fuel_Main.status': ['ACT.ACT_CH7.status'],
  'ACT.LOX_Press.raw_adc_counts': ['ACT.ACT_CH8.raw_adc_counts'],
  'ACT.LOX_Press.status': ['ACT.ACT_CH8.status'],
  // Additional actuators from new CSV
  'ACT.Fuel_Fill_Vent.raw_adc_counts': ['ACT.ACT_CH9.raw_adc_counts'],
  'ACT.Fuel_Fill_Vent.status': ['ACT.ACT_CH9.status'],
  'ACT.Fuel_Fill_Press.raw_adc_counts': ['ACT.ACT_CH10.raw_adc_counts'],
  'ACT.Fuel_Fill_Press.status': ['ACT.ACT_CH10.status'],
  // GN2 Vent is same as GSE Low Vent (CH5)
  'ACT.GN2_Vent.raw_adc_counts': ['ACT.ACT_CH5.raw_adc_counts', 'ACT.GSE_Low_Vent.raw_adc_counts'],
  'ACT.GN2_Vent.status': ['ACT.ACT_CH5.status', 'ACT.GSE_Low_Vent.status'],
};

export { ALIASES };

// ── Batched sensor-data updates (10 Hz) ──────────────────────────────────────
// Accumulate all incoming sensor writes and flush to Zustand once every 100ms.
// Backend broadcasts at 10 Hz per entity so this perfectly coalesces bursts
// into a single setState, keeping React re-renders at ≤10 Hz regardless of
// how many entities are arriving simultaneously.
let _pendingSensorWrites: Record<string, number> = {};
let _flushScheduled = false;
let _updateVersion = 0; // Version counter to force re-renders even if values are identical

// ── Data filtering for spikes ────────────────────────────────────────────────
// Simple moving average filter to smooth out random spikes in sensor data
const FILTER_WINDOW_SIZE = 5; // Number of samples to average
const MAX_SPIKE_THRESHOLD_ABSOLUTE = 200; // PSI - absolute threshold for large values (increased from 50 to handle rapid pressurization)
const MAX_SPIKE_THRESHOLD_PERCENT = 0.5; // 50% - percentage threshold for relative changes

interface FilterState {
  history: number[];
  lastRawValue: number | null;  // Last raw value (before filtering) for spike detection
  lastFilteredValue: number | null;  // Last filtered value (average) for return
}

const _filterState: Map<string, FilterState> = new Map();

function filterSensorValue(key: string, value: number): number {
  // HP PT sensors: filtering disabled for debugging oscillation
  if (key.includes('GSE_Mid') || key.includes('HP_PT_1') || key.includes('GSE_High') || key.includes('HP_PT_3') || key.includes('GN2_High') || key.includes('HP_PT_4')) {
    return value;
  }
  // Tank/reg pressure: allow large legitimate steps (e.g. vented -2 → pressurized 20)
  // so bar plot and graph stay in sync (graph uses raw WS values, bar uses store).
  if (key.includes('Fuel_Upstream') || key.includes('PT_CH1') || key.includes('Fuel_Downstream') || key.includes('PT_CH4') ||
    key.includes('Ox_Upstream') || key.includes('PT_CH5') || key.includes('Ox_Downstream') || key.includes('PT_CH7') ||
    key.includes('GN2_Regulated') || key.includes('PT_CH6') || key.includes('GSE_Low') || key.includes('PT_CH2')) {
    return value;
  }

  // Only filter pressure values (both pressure_psi and raw_adc_counts can have spikes)
  if (!key.includes('pressure_psi') && !key.includes('raw_adc_counts')) {
    return value;
  }

  // For HP PT sensors, use a shared filter key to prevent oscillation between aliases
  // This ensures PT_Cal.GSE_Mid and PT_Cal.HP_PT_1 share the same filter state
  let filterKey = key;
  if (key.includes('GSE_Mid') || key.includes('HP_PT_1')) {
    filterKey = key.replace(/HP_PT_1|GSE_Mid/g, 'GSE_Mid'); // Normalize to GSE_Mid
  } else if (key.includes('GSE_High') || key.includes('HP_PT_3')) {
    filterKey = key.replace(/HP_PT_3|GSE_High/g, 'GSE_High'); // Normalize to GSE_High
  } else if (key.includes('GN2_High') || key.includes('HP_PT_4')) {
    filterKey = key.replace(/HP_PT_4|GN2_High/g, 'GN2_High'); // Normalize to GN2_High
  }

  // Initialize filter state if needed
  if (!_filterState.has(filterKey)) {
    _filterState.set(filterKey, { history: [], lastRawValue: null, lastFilteredValue: null });
  }

  const state = _filterState.get(filterKey)!;

  // Outlier detection: compare against last RAW value (not filtered average) to prevent oscillation
  if (state.lastRawValue !== null) {
    const delta = Math.abs(value - state.lastRawValue);
    const absLastValue = Math.abs(state.lastRawValue);

    // Use percentage-based threshold for small values, absolute for large values
    const threshold = absLastValue > 10
      ? Math.max(MAX_SPIKE_THRESHOLD_ABSOLUTE, absLastValue * MAX_SPIKE_THRESHOLD_PERCENT)
      : Math.max(5, absLastValue * MAX_SPIKE_THRESHOLD_PERCENT); // Minimum 5 PSI threshold

    if (delta > threshold) {
      // Spike detected - use last filtered value instead (smooth transition, not raw)
      if (state.lastFilteredValue !== null) {
        console.warn(`⚠️ Spike detected for ${key}: ${value} (delta: ${delta.toFixed(2)} PSI, threshold: ${threshold.toFixed(2)} PSI), using last filtered value: ${state.lastFilteredValue.toFixed(2)}`);
        return state.lastFilteredValue;
      } else {
        // No filtered value yet, use raw value but don't update history
        return state.lastRawValue;
      }
    }
  }

  // Update last raw value BEFORE filtering
  state.lastRawValue = value;

  // Add to history
  state.history.push(value);
  if (state.history.length > FILTER_WINDOW_SIZE) {
    state.history.shift();
  }

  // Calculate moving average
  const avg = state.history.reduce((a, b) => a + b, 0) / state.history.length;
  state.lastFilteredValue = avg;

  return avg;
}

function scheduleSensorFlush() {
  if (_flushScheduled) return;
  _flushScheduled = true;

  // Use requestAnimationFrame for smooth, synchronized updates with React render cycle
  requestAnimationFrame(() => {
    flushSensorWrites();
  });

  // Fallback timeout: if RAF doesn't fire within 50ms, force flush
  setTimeout(() => {
    if (_flushScheduled) flushSensorWrites();
  }, 50);
}

// Fixed-interval flush: when tab is in background, RAF is paused and setTimeout is heavily
// throttled (~1s), so bar plots freeze. Flush pending writes every 100ms regardless of visibility.
const FLUSH_INTERVAL_MS = 100;
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    if (Object.keys(_pendingSensorWrites).length > 0) {
      _flushScheduled = false;
      flushSensorWrites();
    }
  }, FLUSH_INTERVAL_MS);
}

function flushSensorWrites() {
  _flushScheduled = false;
  const batch = _pendingSensorWrites;
  _pendingSensorWrites = {};
  if (Object.keys(batch).length === 0) return;

  // Increment version counter to force re-renders
  _updateVersion++;

  // Always create a completely new object to ensure Zustand detects the change
  // This is critical for React re-renders - Zustand uses shallow equality checks
  // Even if values are the same, we need a new object reference to trigger selectors
  useSensorStore.setState((state) => {
    // Create new object with all existing data first
    const newSensorData: SensorData = {};
    for (const [key, value] of Object.entries(state.sensorData)) {
      newSensorData[key] = value;
    }
    // Then apply batched updates - always overwrite to ensure new reference
    for (const [key, value] of Object.entries(batch)) {
      newSensorData[key] = value;
    }
    // Return new object with version - this ensures React components re-render
    // The version counter ensures bar plots update even if values are identical
    return { sensorData: newSensorData, _updateVersion: _updateVersion };
  });
}

export const useSensorStore = create<SensorSystemState>((set, get) => ({
  sensorData: {},
  actuators: new Map(),
  currentState: SystemState.IDLE,
  connectionStatus: { connected: false, elodinConnected: false },
  debugMode: false,
  missionStartTime: null,
  actuatorExpectedPositions: {},
  actuatorStateByEntity: {},
  actuatorCommandedOverrides: {},
  boards: {},
  notifications: [],

  updateSensor: (update: SensorUpdate) => {
    const key = `${update.entity}.${update.component}`;
    // Filter out spikes before storing
    const filteredValue = filterSensorValue(key, update.value);
    // Accumulate in pending batch — flush at next animation frame
    _pendingSensorWrites[key] = filteredValue;
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
    console.log('[Store] State update received:', update);
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

  updateBoards: (boards: BoardStatus[]) => {
    set((state) => {
      const next: Record<number, BoardStatus> = { ...state.boards };
      boards.forEach((b) => {
        next[b.id] = b;
      });
      return { boards: next };
    });
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

  // Subscribe to _updateVersion so we re-render on every flush even when value is unchanged
  useSensorStore((state) => state._updateVersion ?? 0);
  return value;
}

export function useGetSensorValue(): (entity: string, component: string) => number | null {
  const sensorData = useSensorStore((state) => state.sensorData);
  return useCallback(
    (entity: string, component: string): number | null => {
      const key = `${entity}.${component}`;
      const direct = sensorData[key];
      if (direct !== undefined) return direct;
      const fallbacks = ALIASES[key];
      if (fallbacks) {
        for (const fb of fallbacks) {
          const v = sensorData[fb];
          if (v !== undefined) return v;
        }
      }
      return null;
    },
    [sensorData]
  );
}

/** Global commanded state for an actuator: override (DEBUG) or expected from current state. */
export function useActuatorCommandedState(entity: string): ActuatorState | null {
  const currentState = useSensorStore((s) => s.currentState);
  const expectedPositions = useSensorStore((s) => s.actuatorExpectedPositions);
  const overrides = useSensorStore((s) => s.actuatorCommandedOverrides);
  const debugMode = useSensorStore((s) => s.debugMode);
  const override = overrides[entity] ?? null;
  const stateExpected = currentState != null ? (expectedPositions[currentState] ?? {}) : {};
  const expected = stateExpected[entity] ?? null;
  if (debugMode && override != null) return override;
  if (expected === 'open') return ActuatorState.OPEN;
  if (expected === 'closed') return ActuatorState.CLOSED;
  return null;
}

/** Global last-known actuator state (from backend or optimistic update). */
export function useActuatorStateByEntity(entity: string): ActuatorState | null {
  return useSensorStore((s) => s.actuatorStateByEntity[entity] ?? null);
}
