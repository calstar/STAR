/**
 * Zustand store for sensor system state
 */

import { create } from 'zustand';
import { SensorUpdate, ActuatorUpdate, StateUpdate, ConnectionStatus, SystemState } from './types';

interface SensorData {
  [key: string]: number; // entity.component -> value
}

interface SensorSystemState {
  // Sensor data
  sensorData: SensorData;

  // Actuator states
  actuators: Map<number, ActuatorUpdate>;

  // State machine
  currentState: SystemState | null;

  // Connection
  connectionStatus: ConnectionStatus;

  // Actions
  updateSensor: (update: SensorUpdate) => void;
  updateActuator: (update: ActuatorUpdate) => void;
  updateState: (update: StateUpdate) => void;
  updateConnectionStatus: (status: ConnectionStatus) => void;
  getSensorValue: (entity: string, component: string) => number | null;
}

export const useSensorStore = create<SensorSystemState>((set, get) => ({
  sensorData: {},
  actuators: new Map(),
  currentState: null,
  connectionStatus: { connected: false, elodinConnected: false },

  updateSensor: (update: SensorUpdate) => {
    const key = `${update.entity}.${update.component}`;
    // Throttle logging to avoid spam (log 10% of updates)
    if (Math.random() < 0.1) {
      console.log(`💾 Store updating: ${key} = ${update.value}`);
    }
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

    // If not found, check aliases (for channels 8-10 that may have different names)
    if (value === undefined) {
      const aliases: Record<string, string[]> = {
        'PT_Cal.GSE_High.pressure_psi': ['PT_Cal.PT_CH8.pressure_psi'],
        'PT_Cal.GN2_High.pressure_psi': ['PT_Cal.PT_CH8.pressure_psi', 'PT_Cal.PT_CH10.pressure_psi'],
        'PT_Cal.Fuel_Transfer_Tank.pressure_psi': ['PT_Cal.PT_CH9.pressure_psi'],
        'PT_Cal.Lox_Fill_Pressure.pressure_psi': ['PT_Cal.PT_CH9.pressure_psi', 'PT_Cal.PT_CH10.pressure_psi'],
        'PT_Cal.GSE_High.raw_adc_counts': ['PT_Cal.PT_CH8.raw_adc_counts'],
        'PT_Cal.GN2_High.raw_adc_counts': ['PT_Cal.PT_CH8.raw_adc_counts', 'PT_Cal.PT_CH10.raw_adc_counts'],
        'PT_Cal.Fuel_Transfer_Tank.raw_adc_counts': ['PT_Cal.PT_CH9.raw_adc_counts'],
        'PT_Cal.Lox_Fill_Pressure.raw_adc_counts': ['PT_Cal.PT_CH9.raw_adc_counts', 'PT_Cal.PT_CH10.raw_adc_counts'],
      };

      const aliasKeys = aliases[key];
      if (aliasKeys) {
        for (const aliasKey of aliasKeys) {
          const aliasValue = get().sensorData[aliasKey];
          if (aliasValue !== undefined) {
            return aliasValue;
          }
        }
      }
    }

    return value ?? null;
  },
}));
