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
import { SensorUpdate, ActuatorUpdate, StateUpdate, ConnectionStatus, SystemState, MissionStartTime } from './types';

interface SensorData {
  [key: string]: number; // entity.component -> value
}

interface SensorSystemState {
  sensorData: SensorData;
  _updateVersion?: number; // Internal version counter to force re-renders
  actuators: Map<number, ActuatorUpdate>;
  currentState: SystemState | null;
  connectionStatus: ConnectionStatus;
  debugMode: boolean;
  missionStartTime: number | null; // T+0 from first packet (backend)
  actuatorExpectedPositions: Record<number, Record<string, 'open' | 'closed' | null>>; // state → entity → position

  updateSensor: (update: SensorUpdate) => void;
  updateActuator: (update: ActuatorUpdate) => void;
  updateState: (update: StateUpdate) => void;
  updateConnectionStatus: (status: ConnectionStatus) => void;
  updateMissionStartTime: (time: number) => void;
  updateActuatorExpectedPositions: (positions: Record<number, Record<string, 'open' | 'closed' | null>>) => void;
  getSensorValue: (entity: string, component: string) => number | null;
  setDebugMode: (mode: boolean) => void;
}

// ── Alias table ──────────────────────────────────────────────────────────────
// Maps lookup key → list of fallback keys to try in order.
const ALIASES: Record<string, string[]> = {
  // ── PT calibrated pressure (named → PT_CHX) ─────────────────────────────
  'PT_Cal.Fuel_Upstream.pressure_psi':    ['PT_Cal.PT_CH1.pressure_psi', 'PT.Fuel_Upstream.pressure_psi', 'PT.PT_CH1.pressure_psi'],
  'PT_Cal.GSE_Low.pressure_psi':          ['PT_Cal.PT_CH2.pressure_psi', 'PT.GSE_Low.pressure_psi', 'PT.PT_CH2.pressure_psi'],
  'PT_Cal.GSE_Mid.pressure_psi':          ['PT_Cal.HP_PT_4.pressure_psi', 'PT.GSE_Mid.pressure_psi'],
  'PT_Cal.HP_PT_4.pressure_psi':          ['PT_Cal.GSE_Mid.pressure_psi', 'PT.GSE_Mid.pressure_psi'],
  'PT_Cal.Fuel_Downstream.pressure_psi':  ['PT_Cal.PT_CH4.pressure_psi', 'PT.Fuel_Downstream.pressure_psi', 'PT.PT_CH4.pressure_psi'],
  'PT_Cal.Ox_Upstream.pressure_psi':      ['PT_Cal.PT_CH5.pressure_psi', 'PT.Ox_Upstream.pressure_psi', 'PT.PT_CH5.pressure_psi'],
  'PT_Cal.GN2_Regulated.pressure_psi':    ['PT_Cal.PT_CH6.pressure_psi', 'PT.GN2_Regulated.pressure_psi', 'PT.PT_CH6.pressure_psi'],
  'PT_Cal.Ox_Downstream.pressure_psi':    ['PT_Cal.PT_CH7.pressure_psi', 'PT.Ox_Downstream.pressure_psi', 'PT.PT_CH7.pressure_psi'],
  'PT_Cal.GSE_High.pressure_psi':         ['PT_Cal.PT_CH8.pressure_psi', 'PT.PT_CH8.pressure_psi'],
  'PT_Cal.GN2_High.pressure_psi':         ['PT_Cal.PT_CH9.pressure_psi', 'PT_Cal.PT_CH10.pressure_psi', 'PT.PT_CH9.pressure_psi', 'PT.PT_CH10.pressure_psi'],

  // ── PT raw ADC counts (named → PT_CHX) ──────────────────────────────────
  'PT_Cal.Fuel_Upstream.raw_adc_counts':   ['PT_Cal.PT_CH1.raw_adc_counts', 'PT.Fuel_Upstream.raw_adc_counts', 'PT.PT_CH1.raw_adc_counts'],
  'PT_Cal.GSE_Low.raw_adc_counts':         ['PT_Cal.PT_CH2.raw_adc_counts', 'PT.PT_CH2.raw_adc_counts'],
  'PT_Cal.GSE_Mid.raw_adc_counts':         ['PT_Cal.HP_PT_4.raw_adc_counts', 'PT.GSE_Mid.raw_adc_counts'],
  'PT_Cal.HP_PT_4.raw_adc_counts':         ['PT_Cal.GSE_Mid.raw_adc_counts'],
  'PT_Cal.PT_CH3.raw_adc_counts':          ['PT.PT_CH3.raw_adc_counts'],
  'PT_Cal.Fuel_Downstream.raw_adc_counts': ['PT_Cal.PT_CH4.raw_adc_counts', 'PT.PT_CH4.raw_adc_counts'],
  'PT_Cal.Ox_Upstream.raw_adc_counts':     ['PT_Cal.PT_CH5.raw_adc_counts', 'PT.PT_CH5.raw_adc_counts'],
  'PT_Cal.GN2_Regulated.raw_adc_counts':   ['PT_Cal.PT_CH6.raw_adc_counts', 'PT.PT_CH6.raw_adc_counts'],
  'PT_Cal.Ox_Downstream.raw_adc_counts':   ['PT_Cal.PT_CH7.raw_adc_counts', 'PT.PT_CH7.raw_adc_counts'],
  'PT_Cal.GSE_High.raw_adc_counts':        ['PT_Cal.PT_CH8.raw_adc_counts', 'PT.PT_CH8.raw_adc_counts'],
  'PT_Cal.GN2_High.raw_adc_counts':        ['PT_Cal.PT_CH9.raw_adc_counts', 'PT_Cal.PT_CH10.raw_adc_counts', 'PT.PT_CH9.raw_adc_counts', 'PT.PT_CH10.raw_adc_counts'],

  // ── PT raw (PT. namespace) → PT_Cal namespace fallback ──────────────────
  'PT.PT_CH1.raw_adc_counts':  ['PT_Cal.PT_CH1.raw_adc_counts',  'PT.Fuel_Upstream.raw_adc_counts'],
  'PT.PT_CH2.raw_adc_counts':  ['PT_Cal.PT_CH2.raw_adc_counts',  'PT.GSE_Low.raw_adc_counts'],
  'PT.PT_CH3.raw_adc_counts':  ['PT_Cal.PT_CH3.raw_adc_counts'],
  'PT.PT_CH4.raw_adc_counts':  ['PT_Cal.PT_CH4.raw_adc_counts',  'PT.Fuel_Downstream.raw_adc_counts'],
  'PT.PT_CH5.raw_adc_counts':  ['PT_Cal.PT_CH5.raw_adc_counts',  'PT.Ox_Upstream.raw_adc_counts'],
  'PT.PT_CH6.raw_adc_counts':  ['PT_Cal.PT_CH6.raw_adc_counts',  'PT.GN2_Regulated.raw_adc_counts'],
  'PT.PT_CH7.raw_adc_counts':  ['PT_Cal.PT_CH7.raw_adc_counts',  'PT.Ox_Downstream.raw_adc_counts'],
  'PT.PT_CH8.raw_adc_counts':  ['PT_Cal.PT_CH8.raw_adc_counts'],
  'PT.PT_CH9.raw_adc_counts':  ['PT_Cal.PT_CH9.raw_adc_counts'],
  'PT.PT_CH10.raw_adc_counts': ['PT_Cal.PT_CH10.raw_adc_counts'],

  // ── Actuator named → ACT_CHX (from config.toml actuator_roles) ──────────
  'ACT.LOX_Main.raw_adc_counts':     ['ACT.ACT_CH1.raw_adc_counts'],
  'ACT.LOX_Main.status':             ['ACT.ACT_CH1.status'],
  'ACT.Fuel_Vent.raw_adc_counts':    ['ACT.ACT_CH2.raw_adc_counts'],
  'ACT.Fuel_Vent.status':            ['ACT.ACT_CH2.status'],
  'ACT.Fuel_Press.raw_adc_counts':   ['ACT.ACT_CH3.raw_adc_counts'],
  'ACT.Fuel_Press.status':           ['ACT.ACT_CH3.status'],
  'ACT.GSE_Low_Vent.raw_adc_counts': ['ACT.ACT_CH5.raw_adc_counts'],
  'ACT.GSE_Low_Vent.status':         ['ACT.ACT_CH5.status'],
  'ACT.LOX_Vent.raw_adc_counts':     ['ACT.ACT_CH6.raw_adc_counts'],
  'ACT.LOX_Vent.status':             ['ACT.ACT_CH6.status'],
  'ACT.Fuel_Main.raw_adc_counts':    ['ACT.ACT_CH7.raw_adc_counts'],
  'ACT.Fuel_Main.status':            ['ACT.ACT_CH7.status'],
  'ACT.LOX_Press.raw_adc_counts':    ['ACT.ACT_CH8.raw_adc_counts'],
  'ACT.LOX_Press.status':            ['ACT.ACT_CH8.status'],
  // Additional actuators from new CSV
  'ACT.Fuel_Fill_Vent.raw_adc_counts': ['ACT.ACT_CH9.raw_adc_counts'],
  'ACT.Fuel_Fill_Vent.status':        ['ACT.ACT_CH9.status'],
  'ACT.Fuel_Fill_Press.raw_adc_counts': ['ACT.ACT_CH10.raw_adc_counts'],
  'ACT.Fuel_Fill_Press.status':       ['ACT.ACT_CH10.status'],
  // GN2 Vent is same as GSE Low Vent (CH5)
  'ACT.GN2_Vent.raw_adc_counts':     ['ACT.ACT_CH5.raw_adc_counts', 'ACT.GSE_Low_Vent.raw_adc_counts'],
  'ACT.GN2_Vent.status':             ['ACT.ACT_CH5.status', 'ACT.GSE_Low_Vent.status'],
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
  lastValue: number | null;
}

const _filterState: Map<string, FilterState> = new Map();

function filterSensorValue(key: string, value: number): number {
  // Only filter pressure values (both pressure_psi and raw_adc_counts can have spikes)
  if (!key.includes('pressure_psi') && !key.includes('raw_adc_counts')) {
    return value;
  }

  // Initialize filter state if needed
  if (!_filterState.has(key)) {
    _filterState.set(key, { history: [], lastValue: null });
  }

  const state = _filterState.get(key)!;

  // Outlier detection: if value jumps too much from last value, reject it
  if (state.lastValue !== null) {
    const delta = Math.abs(value - state.lastValue);
    const absLastValue = Math.abs(state.lastValue);

    // Use percentage-based threshold for small values, absolute for large values
    const threshold = absLastValue > 10
      ? Math.max(MAX_SPIKE_THRESHOLD_ABSOLUTE, absLastValue * MAX_SPIKE_THRESHOLD_PERCENT)
      : Math.max(5, absLastValue * MAX_SPIKE_THRESHOLD_PERCENT); // Minimum 5 PSI threshold

    if (delta > threshold) {
      // Spike detected - use last value instead
      console.warn(`⚠️ Spike detected for ${key}: ${value} (delta: ${delta.toFixed(2)} PSI, threshold: ${threshold.toFixed(2)} PSI), using last value: ${state.lastValue}`);
      return state.lastValue;
    }
  }

  // Add to history
  state.history.push(value);
  if (state.history.length > FILTER_WINDOW_SIZE) {
    state.history.shift();
  }

  // Calculate moving average
  const avg = state.history.reduce((a, b) => a + b, 0) / state.history.length;
  state.lastValue = avg;

  return avg;
}

function scheduleSensorFlush() {
  if (_flushScheduled) return;
  _flushScheduled = true;

  // Use requestAnimationFrame for smooth, synchronized updates with React render cycle
  // This ensures updates happen before the next paint, keeping bar plots and graphs in sync
  requestAnimationFrame(() => {
    flushSensorWrites();
  });

  // Fallback timeout: if requestAnimationFrame doesn't fire within 50ms, force flush
  // This prevents bar plots from freezing if the browser tab is in background
  setTimeout(() => {
    if (_flushScheduled) {
      flushSensorWrites();
    }
  }, 50);
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

  updateSensor: (update: SensorUpdate) => {
    const key = `${update.entity}.${update.component}`;
    // Filter out spikes before storing
    const filteredValue = filterSensorValue(key, update.value);
    // Accumulate in pending batch — flush at next animation frame
    _pendingSensorWrites[key] = filteredValue;
    scheduleSensorFlush();
  },

  updateActuator: (update: ActuatorUpdate) => {
    set((state) => {
      const actuators = new Map(state.actuators);
      actuators.set(update.actuatorId, update);
      return { actuators };
    });
  },

  updateState: (update: StateUpdate) => {
    console.log('[Store] State update received:', update);
    set({
      currentState: update.currentState,
      // Debug mode is now a persistent mode, not tied to DEBUG state
      // Update from backend if provided, otherwise keep current value
      debugMode: update.debugMode !== undefined ? update.debugMode : get().debugMode,
    });
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
    set({ debugMode: mode });
  },
}));

// ── Reactive sensor-value hooks ──────────────────────────────────────────────

export function useSensorValue(entity: string, component: string): number | null {
  const key = `${entity}.${component}`;

  // Subscribe to the specific value AND updateVersion to ensure we catch all updates
  // Using a selector that returns the specific value ensures Zustand triggers re-renders
  // when that specific key changes, even if the sensorData object reference is the same
  const value = useSensorStore((state) => {
    // Direct lookup
    const direct = state.sensorData[key];
    if (direct !== undefined) return direct;

    // Fallback to aliases
    const fallbacks = ALIASES[key];
    if (fallbacks) {
      for (const fb of fallbacks) {
        const v = state.sensorData[fb];
        if (v !== undefined) return v;
      }
    }

    return null;
  });

  // Also subscribe to updateVersion to force re-renders even if value is the same
  // This ensures bar plots stay synchronized with graphs
  const updateVersion = useSensorStore((state) => state._updateVersion || 0);

  // Return the value - Zustand will trigger re-render when the selected value changes
  // The updateVersion subscription ensures we also re-render on every flush
  return useMemo(() => value, [value, updateVersion]);
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
