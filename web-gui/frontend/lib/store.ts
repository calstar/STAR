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

// ── Alias table ──────────────────────────────────────────────────────────────
// Maps lookup key → list of fallback keys to try in order.
const ALIASES: Record<string, string[]> = {
  // ── PT calibrated pressure (named → PT_CHX / CHn) ────────────────────────
  // Backend may send PT_Cal.CH{n} when channelToEntityMap fails; include as fallbacks
  'PT_Cal.Fuel_Upstream.pressure_psi': ['PT_Cal.CH1.pressure_psi', 'PT_Cal.PT_CH1.pressure_psi', 'PT.Fuel_Upstream.pressure_psi', 'PT.PT_CH1.pressure_psi'],
  'PT_Cal.GSE_Low.pressure_psi': ['PT_Cal.CH2.pressure_psi', 'PT_Cal.PT_CH2.pressure_psi', 'PT.GSE_Low.pressure_psi', 'PT.PT_CH2.pressure_psi'],
  'PT_Cal.Fuel_Downstream.pressure_psi': ['PT_Cal.CH3.pressure_psi', 'PT_Cal.PT_CH3.pressure_psi', 'PT.Fuel_Downstream.pressure_psi', 'PT.PT_CH3.pressure_psi'],
  'PT_Cal.Chamber_Mid_PT_1.pressure_psi': ['PT_Cal.CH4.pressure_psi', 'PT_Cal.PT_CH4.pressure_psi', 'PT.Chamber_Mid_PT_1.pressure_psi', 'PT.PT_CH4.pressure_psi'],
  'PT_Cal.Chamber_Mid_PT_2.pressure_psi': ['PT_Cal.CH8.pressure_psi', 'PT_Cal.PT_CH8.pressure_psi', 'PT.Chamber_Mid_PT_2.pressure_psi', 'PT.PT_CH8.pressure_psi'],
  'PT_Cal.Chamber_Throat_PT_1.pressure_psi': ['PT_Cal.CH9.pressure_psi', 'PT_Cal.PT_CH9.pressure_psi', 'PT.Chamber_Throat_PT_1.pressure_psi', 'PT.PT_CH9.pressure_psi'],
  'PT_Cal.Chamber_Throat_PT_2.pressure_psi': ['PT_Cal.CH10.pressure_psi', 'PT_Cal.PT_CH10.pressure_psi', 'PT.Chamber_Throat_PT_2.pressure_psi', 'PT.PT_CH10.pressure_psi'],
  'PT_Cal.Fuel_Fill_Tank.pressure_psi': ['PT_Cal.CH4.pressure_psi', 'PT_Cal.PT_CH4.pressure_psi', 'PT.Fuel_Fill_Tank.pressure_psi', 'PT.PT_CH4.pressure_psi'],
  'PT_Cal.Ox_Upstream.pressure_psi': ['PT_Cal.CH5.pressure_psi', 'PT_Cal.PT_CH5.pressure_psi', 'PT.Ox_Upstream.pressure_psi', 'PT.PT_CH5.pressure_psi'],
  'PT_Cal.GN2_Regulated.pressure_psi': ['PT_Cal.CH6.pressure_psi', 'PT_Cal.PT_CH6.pressure_psi', 'PT.GN2_Regulated.pressure_psi', 'PT.PT_CH6.pressure_psi'],
  'PT_Cal.Ox_Downstream.pressure_psi': ['PT_Cal.CH7.pressure_psi', 'PT_Cal.PT_CH7.pressure_psi', 'PT.Ox_Downstream.pressure_psi', 'PT.PT_CH7.pressure_psi'],
  // HP PT sensors: CH11=GSE_High, CH13=GSE_Mid, CH14=GN2_High (pt2 channel_offset 10)
  'PT_Cal.GSE_Mid.pressure_psi': ['PT_Cal.CH13.pressure_psi', 'PT_Cal.HP_PT_1.pressure_psi', 'PT.GSE_Mid.pressure_psi'],
  'PT_Cal.HP_PT_1.pressure_psi': ['PT_Cal.CH13.pressure_psi', 'PT_Cal.GSE_Mid.pressure_psi', 'PT.GSE_Mid.pressure_psi'],
  'PT_Cal.GSE_High.pressure_psi': ['PT_Cal.CH11.pressure_psi', 'PT_Cal.HP_PT_3.pressure_psi', 'PT.GSE_High.pressure_psi'],
  'PT_Cal.HP_PT_3.pressure_psi': ['PT_Cal.CH11.pressure_psi', 'PT_Cal.GSE_High.pressure_psi', 'PT.GSE_High.pressure_psi'],
  'PT_Cal.GN2_High.pressure_psi': ['PT_Cal.CH14.pressure_psi', 'PT_Cal.HP_PT_4.pressure_psi', 'PT.GN2_High.pressure_psi'],
  'PT_Cal.HP_PT_4.pressure_psi': ['PT_Cal.CH14.pressure_psi', 'PT_Cal.GN2_High.pressure_psi', 'PT.GN2_High.pressure_psi'],

  // ── PT raw ADC counts (named → PT.<role> / CHn / PT_CHX fallbacks) ────────
  'PT_Cal.Fuel_Upstream.raw_adc_counts': ['PT.CH1.raw_adc_counts', 'PT.Fuel_Upstream.raw_adc_counts', 'PT_Cal.PT_CH1.raw_adc_counts', 'PT.PT_CH1.raw_adc_counts'],
  'PT_Cal.GSE_Low.raw_adc_counts': ['PT.CH2.raw_adc_counts', 'PT.GSE_Low.raw_adc_counts', 'PT_Cal.PT_CH2.raw_adc_counts', 'PT.PT_CH2.raw_adc_counts'],
  'PT_Cal.PT_CH3.raw_adc_counts': ['PT.CH3.raw_adc_counts', 'PT.PT_CH3.raw_adc_counts', 'PT.Fuel_Downstream.raw_adc_counts'],
  'PT_Cal.Fuel_Downstream.raw_adc_counts': ['PT.CH3.raw_adc_counts', 'PT.Fuel_Downstream.raw_adc_counts', 'PT_Cal.PT_CH3.raw_adc_counts', 'PT.PT_CH3.raw_adc_counts'],
  'PT_Cal.Chamber_Mid_PT_1.raw_adc_counts': ['PT.CH4.raw_adc_counts', 'PT.Chamber_Mid_PT_1.raw_adc_counts', 'PT_Cal.PT_CH4.raw_adc_counts', 'PT.PT_CH4.raw_adc_counts'],
  'PT_Cal.Chamber_Mid_PT_2.raw_adc_counts': ['PT.CH8.raw_adc_counts', 'PT.Chamber_Mid_PT_2.raw_adc_counts', 'PT_Cal.PT_CH8.raw_adc_counts', 'PT.PT_CH8.raw_adc_counts'],
  'PT_Cal.Chamber_Throat_PT_1.raw_adc_counts': ['PT.CH9.raw_adc_counts', 'PT.Chamber_Throat_PT_1.raw_adc_counts', 'PT_Cal.PT_CH9.raw_adc_counts', 'PT.PT_CH9.raw_adc_counts'],
  'PT_Cal.Chamber_Throat_PT_2.raw_adc_counts': ['PT.CH10.raw_adc_counts', 'PT.Chamber_Throat_PT_2.raw_adc_counts', 'PT_Cal.PT_CH10.raw_adc_counts', 'PT.PT_CH10.raw_adc_counts'],
  'PT_Cal.Fuel_Fill_Tank.raw_adc_counts': ['PT.CH4.raw_adc_counts', 'PT_Cal.PT_CH4.raw_adc_counts', 'PT.PT_CH4.raw_adc_counts'],
  'PT_Cal.Ox_Upstream.raw_adc_counts': ['PT.CH5.raw_adc_counts', 'PT.Ox_Upstream.raw_adc_counts', 'PT_Cal.PT_CH5.raw_adc_counts', 'PT.PT_CH5.raw_adc_counts'],
  'PT_Cal.GN2_Regulated.raw_adc_counts': ['PT.CH6.raw_adc_counts', 'PT.GN2_Regulated.raw_adc_counts', 'PT_Cal.PT_CH6.raw_adc_counts', 'PT.PT_CH6.raw_adc_counts'],
  'PT_Cal.Ox_Downstream.raw_adc_counts': ['PT.CH7.raw_adc_counts', 'PT.Ox_Downstream.raw_adc_counts', 'PT_Cal.PT_CH7.raw_adc_counts', 'PT.PT_CH7.raw_adc_counts'],
  // HP PT sensors: named entities only (no PT_CH channel fallback)
  'PT_Cal.GSE_Mid.raw_adc_counts': ['PT_Cal.HP_PT_1.raw_adc_counts', 'PT.GSE_Mid.raw_adc_counts'],
  'PT_Cal.HP_PT_1.raw_adc_counts': ['PT_Cal.GSE_Mid.raw_adc_counts', 'PT.GSE_Mid.raw_adc_counts'],
  'PT_Cal.GSE_High.raw_adc_counts': ['PT_Cal.HP_PT_3.raw_adc_counts', 'PT.GSE_High.raw_adc_counts'],
  'PT_Cal.HP_PT_3.raw_adc_counts': ['PT_Cal.GSE_High.raw_adc_counts', 'PT.GSE_High.raw_adc_counts'],
  'PT_Cal.GN2_High.raw_adc_counts': ['PT_Cal.HP_PT_4.raw_adc_counts', 'PT.GN2_High.raw_adc_counts'],
  'PT_Cal.HP_PT_4.raw_adc_counts': ['PT_Cal.GN2_High.raw_adc_counts', 'PT.GN2_High.raw_adc_counts'],

  // HP PT diagnostics
  'PT_Cal.GSE_Mid.current_ma': ['PT_Cal.HP_PT_1.current_ma'],
  'PT_Cal.HP_PT_1.current_ma': ['PT_Cal.GSE_Mid.current_ma'],
  'PT_Cal.GSE_High.current_ma': ['PT_Cal.HP_PT_3.current_ma'],
  'PT_Cal.HP_PT_3.current_ma': ['PT_Cal.GSE_High.current_ma'],
  'PT_Cal.GN2_High.current_ma': ['PT_Cal.HP_PT_4.current_ma'],
  'PT_Cal.HP_PT_4.current_ma': ['PT_Cal.GN2_High.current_ma'],

  'PT_Cal.GSE_Mid.sense_voltage': ['PT_Cal.HP_PT_1.sense_voltage'],
  'PT_Cal.HP_PT_1.sense_voltage': ['PT_Cal.GSE_Mid.sense_voltage'],
  'PT_Cal.GSE_High.sense_voltage': ['PT_Cal.HP_PT_3.sense_voltage'],
  'PT_Cal.HP_PT_3.sense_voltage': ['PT_Cal.GSE_High.sense_voltage'],
  'PT_Cal.GN2_High.sense_voltage': ['PT_Cal.HP_PT_4.sense_voltage'],
  'PT_Cal.HP_PT_4.sense_voltage': ['PT_Cal.GN2_High.sense_voltage'],

  'PT_Cal.GSE_Mid.excitation_voltage': ['PT_Cal.HP_PT_1.excitation_voltage'],
  'PT_Cal.HP_PT_1.excitation_voltage': ['PT_Cal.GSE_Mid.excitation_voltage'],
  'PT_Cal.GSE_High.excitation_voltage': ['PT_Cal.HP_PT_3.excitation_voltage'],
  'PT_Cal.HP_PT_3.excitation_voltage': ['PT_Cal.GSE_High.excitation_voltage'],
  'PT_Cal.GN2_High.excitation_voltage': ['PT_Cal.HP_PT_4.excitation_voltage'],
  'PT_Cal.HP_PT_4.excitation_voltage': ['PT_Cal.GN2_High.excitation_voltage'],

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

  // ── Controller actuation → Fuel/Ox display (duty 0–1, onoff from u_F_on/u_O_on) ─────
  'CONTROLLER.Fuel.duty_cycle': ['CONTROLLER.actuation.duty_F', 'CONTROLLER.fire.duty_F'],
  'CONTROLLER.Fuel.onoff': ['CONTROLLER.actuation.u_F_on', 'CONTROLLER.fire.fire_active'],
  'CONTROLLER.Ox.duty_cycle': ['CONTROLLER.actuation.duty_O', 'CONTROLLER.fire.duty_O'],
  'CONTROLLER.Ox.onoff': ['CONTROLLER.actuation.u_O_on', 'CONTROLLER.fire.fire_active'],
};

export { ALIASES };

// ── Batched sensor-data updates (10 Hz) ──────────────────────────────────────
// Accumulate incoming sensor writes and flush to Zustand every 100ms.
// 10 Hz reduces browser lag while keeping display responsive.
let _pendingSensorWrites: Record<string, number> = {};
let _sensorTimestamps: Record<string, number> = {};
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
  return value;
}

function scheduleSensorFlush() {
  if (_flushScheduled) return;
  _flushScheduled = true;

  requestAnimationFrame(() => {
    flushSensorWrites();
  });
  setTimeout(() => {
    if (_flushScheduled) flushSensorWrites();
  }, FLUSH_INTERVAL_MS);
}

// Flush pending writes at 10 Hz.
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
  if (typeof document !== 'undefined' && document.hidden) return; // defer when tab in background
  const batch = _pendingSensorWrites;
  _pendingSensorWrites = {};
  if (Object.keys(batch).length === 0) return;

  _updateVersion++;
  const version = _updateVersion;
  const now = Date.now();
  useSensorStore.setState((state) => {
    const newSensorData: SensorData = { ...state.sensorData };
    for (const [key, value] of Object.entries(batch)) {
      newSensorData[key] = value;
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

    // Late packet rejection: ensure we don't overwrite new data with buffered old data
    const prevTimestamp = _sensorTimestamps[key] || 0;
    // If packet is older than the newest we've seen (and not a reboot), drop it.
    // (Allow reboot detect: if timestamp drops by > 60 seconds, accept it)
    if (update.timestamp < prevTimestamp && (prevTimestamp - update.timestamp < 60000)) {
      return;
    }
    _sensorTimestamps[key] = update.timestamp;

    // Filter out spikes before storing
    const filteredValue = filterSensorValue(key, update.value);
    // Accumulate in pending batch — flush at next animation frame
    _pendingSensorWrites[key] = filteredValue;
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

/** Commanded state for display: in normal mode use state-machine expected for current state; in DEBUG use override then expected then actuatorStateByEntity. */
export function useActuatorCommandedState(entity: string): ActuatorState | null {
  const currentState = useSensorStore((s) => s.currentState);
  const expectedPositions = useSensorStore((s) => s.actuatorExpectedPositions);
  const overrides = useSensorStore((s) => s.actuatorCommandedOverrides);
  const debugMode = useSensorStore((s) => s.debugMode);
  const actuatorStateByEntity = useSensorStore((s) => s.actuatorStateByEntity[entity] ?? null);

  // When not in DEBUG, state machine is source of truth: show expected for current state so Idle/Armed etc. are correct
  if (!debugMode && currentState != null) {
    const stateExpected = expectedPositions[currentState] ?? {};
    const expected = stateExpected[entity] ?? null;
    if (expected === 'open') return ActuatorState.OPEN;
    if (expected === 'closed') return ActuatorState.CLOSED;
  }

  if (debugMode) {
    const override = overrides[entity] ?? null;
    if (override != null) return override;
    if (currentState != null) {
      const stateExpected = expectedPositions[currentState] ?? {};
      const expected = stateExpected[entity] ?? null;
      if (expected === 'open') return ActuatorState.OPEN;
      if (expected === 'closed') return ActuatorState.CLOSED;
    }
  }

  return actuatorStateByEntity;
}

/** Global last-known actuator state (from backend or optimistic update). */
export function useActuatorStateByEntity(entity: string): ActuatorState | null {
  return useSensorStore((s) => s.actuatorStateByEntity[entity] ?? null);
}

/** Load cell force (lbf) with zero offset applied. Use for display: displayLbf = raw - offset. */
export function useLoadCellForceLbf(calEntity: string): number | null {
  const raw = useSensorValue(calEntity, 'force_lbf');
  const offset = useSensorStore((s) => s.loadCellZeroOffsets[calEntity] ?? 0);
  if (raw == null || !Number.isFinite(raw)) return null;
  return raw - offset;
}
