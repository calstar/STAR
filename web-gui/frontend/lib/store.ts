/**
 * Zustand store for sensor system state
 *
 * ENTITY NAME ALIASES
 * The backend can run in two modes:
 *  1. Direct-DAQ mode → emits named entities  e.g. PT_Cal.Fuel_Upstream.pressure_psi
 *  2. Elodin-DB mode  → emits channel entities e.g. PT_Cal.PT_CH1.pressure_psi
 *
 * Sensor-role → channel mapping (from config.toml):
 *   Fuel Upstream = CH1, GSE Low = CH2, GSE Mid = CH3, Fuel Downstream = CH4
 *   Ox Upstream   = CH5, GN2 Regulated = CH6, Ox Downstream = CH7
 *
 * Actuator-role → channel mapping (from config.toml actuator_roles):
 *   LOX Main = CH1, Fuel Vent = CH2, Fuel Press = CH3, GSE Low Vent = CH5
 *   LOX Vent = CH6, Fuel Main  = CH7, LOX Press  = CH8
 */

import { create } from 'zustand';
import { useCallback } from 'react';
import { SensorUpdate, ActuatorUpdate, StateUpdate, ConnectionStatus, SystemState } from './types';

interface SensorData {
  [key: string]: number; // entity.component -> value
}

interface SensorSystemState {
  sensorData: SensorData;
  actuators: Map<number, ActuatorUpdate>;
  currentState: SystemState | null;
  connectionStatus: ConnectionStatus;

  updateSensor: (update: SensorUpdate) => void;
  updateActuator: (update: ActuatorUpdate) => void;
  updateState: (update: StateUpdate) => void;
  updateConnectionStatus: (status: ConnectionStatus) => void;
  getSensorValue: (entity: string, component: string) => number | null;
}

// ── Alias table ──────────────────────────────────────────────────────────────
// Maps lookup key → list of fallback keys to try in order.
// This lets the frontend work regardless of which entity-naming mode the backend
// happens to be using.
const ALIASES: Record<string, string[]> = {
  // ── PT calibrated pressure (named → PT_CHX) ─────────────────────────────
  'PT_Cal.Fuel_Upstream.pressure_psi':    ['PT_Cal.PT_CH1.pressure_psi', 'PT.Fuel_Upstream.pressure_psi'],
  'PT_Cal.GSE_Low.pressure_psi':          ['PT_Cal.PT_CH2.pressure_psi', 'PT.GSE_Low.pressure_psi'],
  'PT_Cal.GSE_Mid.pressure_psi':          ['PT_Cal.PT_CH3.pressure_psi', 'PT.GSE_Mid.pressure_psi'],
  'PT_Cal.Fuel_Downstream.pressure_psi':  ['PT_Cal.PT_CH4.pressure_psi', 'PT.Fuel_Downstream.pressure_psi'],
  'PT_Cal.Ox_Upstream.pressure_psi':      ['PT_Cal.PT_CH5.pressure_psi', 'PT.Ox_Upstream.pressure_psi'],
  'PT_Cal.GN2_Regulated.pressure_psi':    ['PT_Cal.PT_CH6.pressure_psi', 'PT.GN2_Regulated.pressure_psi'],
  'PT_Cal.Ox_Downstream.pressure_psi':    ['PT_Cal.PT_CH7.pressure_psi', 'PT.Ox_Downstream.pressure_psi'],
  'PT_Cal.GSE_High.pressure_psi':         ['PT_Cal.PT_CH8.pressure_psi'],
  'PT_Cal.GN2_High.pressure_psi':         ['PT_Cal.PT_CH9.pressure_psi', 'PT_Cal.PT_CH10.pressure_psi'],

  // ── PT raw ADC counts (named → PT_CHX) ──────────────────────────────────
  'PT_Cal.Fuel_Upstream.raw_adc_counts':   ['PT_Cal.PT_CH1.raw_adc_counts', 'PT.Fuel_Upstream.raw_adc_counts', 'PT.PT_CH1.raw_adc_counts'],
  'PT_Cal.GSE_Low.raw_adc_counts':         ['PT_Cal.PT_CH2.raw_adc_counts', 'PT.PT_CH2.raw_adc_counts'],
  'PT_Cal.GSE_Mid.raw_adc_counts':         ['PT_Cal.PT_CH3.raw_adc_counts', 'PT.PT_CH3.raw_adc_counts'],
  'PT_Cal.Fuel_Downstream.raw_adc_counts': ['PT_Cal.PT_CH4.raw_adc_counts', 'PT.PT_CH4.raw_adc_counts'],
  'PT_Cal.Ox_Upstream.raw_adc_counts':     ['PT_Cal.PT_CH5.raw_adc_counts', 'PT.PT_CH5.raw_adc_counts'],
  'PT_Cal.GN2_Regulated.raw_adc_counts':   ['PT_Cal.PT_CH6.raw_adc_counts', 'PT.PT_CH6.raw_adc_counts'],
  'PT_Cal.Ox_Downstream.raw_adc_counts':   ['PT_Cal.PT_CH7.raw_adc_counts', 'PT.PT_CH7.raw_adc_counts'],
  'PT_Cal.GSE_High.raw_adc_counts':        ['PT_Cal.PT_CH8.raw_adc_counts', 'PT.PT_CH8.raw_adc_counts'],
  'PT_Cal.GN2_High.raw_adc_counts':        ['PT_Cal.PT_CH9.raw_adc_counts', 'PT_Cal.PT_CH10.raw_adc_counts'],

  // ── PT raw (PT. namespace) → PT_Cal namespace fallback ──────────────────
  // Elodin-DB mode emits PT_Cal.PT_CHX.raw_adc_counts, raw plots use PT.PT_CHX
  'PT.PT_CH1.raw_adc_counts':  ['PT_Cal.PT_CH1.raw_adc_counts',  'PT.Fuel_Upstream.raw_adc_counts'],
  'PT.PT_CH2.raw_adc_counts':  ['PT_Cal.PT_CH2.raw_adc_counts',  'PT.GSE_Low.raw_adc_counts'],
  'PT.PT_CH3.raw_adc_counts':  ['PT_Cal.PT_CH3.raw_adc_counts',  'PT.GSE_Mid.raw_adc_counts'],
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
};

export { ALIASES };

export const useSensorStore = create<SensorSystemState>((set, get) => ({
  sensorData: {},
  actuators: new Map(),
  currentState: SystemState.IDLE,
  connectionStatus: { connected: false, elodinConnected: false },

  updateSensor: (update: SensorUpdate) => {
    const key = `${update.entity}.${update.component}`;
    set((state) => ({
      sensorData: {
        ...state.sensorData,
        [key]: update.value,
      },
    }));
  },

  updateActuator: (update: ActuatorUpdate) => {
    set((state) => {
      const actuators = new Map(state.actuators);
      actuators.set(update.actuatorId, update);
      return { actuators };
    });
  },

  updateState: (update: StateUpdate) => {
    set({ currentState: update.currentState });
  },

  updateConnectionStatus: (status: ConnectionStatus) => {
    set({ connectionStatus: status });
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
}));

// ── Reactive sensor-value hooks ──────────────────────────────────────────────
//
// WHY these exist:
//   useSensorStore((state) => state.getSensorValue) returns a STABLE function
//   reference that never changes → Zustand never triggers a re-render when
//   sensorData updates.  These hooks subscribe to sensorData directly so
//   components receive live updates.
//
// useSensorValue(entity, component)
//   Best for a SINGLE known entity/component pair (e.g. one pressure card).
//   Only re-renders when that specific value changes.
//
// useGetSensorValue()
//   Returns a getSensorValue(entity,component) function.
//   Use this when a component calls getSensorValue multiple times or the
//   entity/component strings are dynamic.  Re-renders whenever sensorData
//   changes (but that's expected for live-data tables / dashboards).

export function useSensorValue(entity: string, component: string): number | null {
  return useSensorStore((state) => {
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
  });
}

export function useGetSensorValue(): (entity: string, component: string) => number | null {
  // Subscribe to sensorData so the returned function is always "fresh"
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
