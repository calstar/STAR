/**
 * Data flow simulation tests.
 *
 * Tests the full data pipeline from simulated WS messages through to the
 * Zustand store, and from command dispatch through to WebSocket output.
 * No real infrastructure needed — all WebSocket communication is mocked.
 *
 * Note: The store's sensor batching uses setInterval registered at module load,
 * so we use real timers with small async waits for updateSensor tests, and
 * direct setState for alias resolution tests (which don't need batching).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useSensorStore, ALIASES, buildAliasesFromConfig } from '@/lib/store';
import {
  SystemState,
  ActuatorState,
} from '@/lib/types';
import { waitForSensorFlush } from './waitForSensorFlush';

// ── Store reset helper ───────────────────────────────────────────────────────

function resetStore() {
  useSensorStore.setState({
    sensorData: {},
    actuators: new Map(),
    currentState: SystemState.IDLE,
    actuatorStateByEntity: {},
    actuatorCommandedOverrides: {},
    actuatorExpectedPositions: {},
    debugMode: false,
    connectionStatus: { connected: false, elodinConnected: false },
    missionStartTime: null,
    boards: {},
    notifications: [],
  });
}

beforeEach(() => {
  resetStore();
});

// ── Test 1: Sensor data → store (uses real timers + async wait) ──────────────

describe('Sensor data → store', () => {
  it('should store sensor updates with correct key format', async () => {
    const { updateSensor } = useSensorStore.getState();

    updateSensor({
      entity: 'PT_Cal.PT_CH1',
      component: 'pressure_psi',
      value: 42.5,
      timestamp: Date.now(),
    });

    await waitForSensorFlush();

    const state = useSensorStore.getState();
    expect(state.sensorData['PT_Cal.PT_CH1.pressure_psi']).toBe(42.5);
  });

  it('should store multiple channel updates', async () => {
    const { updateSensor } = useSensorStore.getState();

    for (let ch = 1; ch <= 10; ch++) {
      updateSensor({
        entity: `PT_Cal.PT_CH${ch}`,
        component: 'pressure_psi',
        value: 50 + ch,
        timestamp: Date.now(),
      });
    }

    await waitForSensorFlush();

    const state = useSensorStore.getState();
    for (let ch = 1; ch <= 10; ch++) {
      expect(state.sensorData[`PT_Cal.PT_CH${ch}.pressure_psi`]).toBe(50 + ch);
    }
  });

  it('should store raw ADC counts alongside calibrated values', async () => {
    const { updateSensor } = useSensorStore.getState();

    updateSensor({
      entity: 'PT.PT_CH1',
      component: 'raw_adc_counts',
      value: 1500000,
      timestamp: Date.now(),
    });
    updateSensor({
      entity: 'PT_Cal.PT_CH1',
      component: 'pressure_psi',
      value: 75.0,
      timestamp: Date.now(),
    });

    await waitForSensorFlush();

    const state = useSensorStore.getState();
    expect(state.sensorData['PT.PT_CH1.raw_adc_counts']).toBe(1500000);
    expect(state.sensorData['PT_Cal.PT_CH1.pressure_psi']).toBe(75.0);
  });

  it('should apply updates in arrival order (no timestamp-based drop)', async () => {
    const { updateSensor } = useSensorStore.getState();
    const now = Date.now();

    updateSensor({ entity: 'PT_Cal.PT_CH1', component: 'pressure_psi', value: 50, timestamp: now });
    await waitForSensorFlush();

    updateSensor({ entity: 'PT_Cal.PT_CH1', component: 'pressure_psi', value: 999, timestamp: now - 1000 });
    await waitForSensorFlush();

    expect(useSensorStore.getState().sensorData['PT_Cal.PT_CH1.pressure_psi']).toBe(999);
  });

  it('should batch updates (pending writes accumulate before flush)', async () => {
    const { updateSensor } = useSensorStore.getState();

    // Send 10 updates rapidly
    for (let i = 1; i <= 10; i++) {
      updateSensor({
        entity: `PT_Cal.PT_CH${i}`,
        component: 'pressure_psi',
        value: i * 10,
        timestamp: Date.now(),
      });
    }

    // Wait for flush
    await waitForSensorFlush();

    // After flush — all 10 should be present
    const state = useSensorStore.getState();
    expect(Object.keys(state.sensorData).length).toBe(10);
    expect(state.sensorData['PT_Cal.PT_CH5.pressure_psi']).toBe(50);
  });
});

// ── Test 2: Alias resolution (uses direct setState, no batching needed) ──────

describe('Alias resolution via getSensorValue()', () => {
  beforeEach(() => {
    buildAliasesFromConfig({
      boards: {
        pt1: { type: 'PT', board_id: 1, enabled: true, num_sensors: 10 },
      },
      sensor_roles_pt1: {
        'Fuel Upstream': 1,
        PT_CH1: 1,
      },
      actuator_roles: {
        'LOX Main': ['NC', 1, 12],
      },
    });
  });

  it('should resolve named entity to channel data via alias', () => {
    // Board-scoped stream key (backend + Elodin use PT1_Cal.CH*).
    useSensorStore.setState({
      sensorData: { 'PT1_Cal.CH1.pressure_psi': 100.5 },
    });

    const value = useSensorStore.getState().getSensorValue('PT_Cal.Fuel_Upstream', 'pressure_psi');
    expect(value).toBe(100.5);
  });

  it('should return direct value when available (no alias needed)', () => {
    useSensorStore.setState({
      sensorData: { 'PT_Cal.Fuel_Upstream.pressure_psi': 200.0 },
    });

    const value = useSensorStore.getState().getSensorValue('PT_Cal.Fuel_Upstream', 'pressure_psi');
    expect(value).toBe(200.0);
  });

  it('should resolve actuator aliases (named → channel)', () => {
    useSensorStore.setState({
      sensorData: { 'ACT2.CH1.raw_adc_counts': 1500000 },
    });

    const value = useSensorStore.getState().getSensorValue('ACT2.LOX_Main', 'raw_adc_counts');
    expect(value).toBe(1500000);
  });

  it('should prefer direct value over alias', () => {
    useSensorStore.setState({
      sensorData: {
        'PT_Cal.Fuel_Upstream.pressure_psi': 999,   // direct
        'PT_Cal.CH1.pressure_psi': 100,              // alias fallback
      },
    });

    const value = useSensorStore.getState().getSensorValue('PT_Cal.Fuel_Upstream', 'pressure_psi');
    expect(value).toBe(999); // Direct value wins
  });

  it('should return null for unknown entities', () => {
    const value = useSensorStore.getState().getSensorValue('NONEXISTENT.Entity', 'pressure_psi');
    expect(value).toBeNull();
  });

  it('should have valid alias entries (all aliases reference string arrays)', () => {
    for (const [key, fallbacks] of Object.entries(ALIASES)) {
      expect(Array.isArray(fallbacks)).toBe(true);
      expect(fallbacks.length).toBeGreaterThan(0);
      for (const fb of fallbacks) {
        expect(typeof fb).toBe('string');
      }
    }
  });

  it('should resolve PT raw aliases across namespaces', () => {
    useSensorStore.setState({
      sensorData: { 'PT1.CH1.raw_adc_counts': 1234567 },
    });

    const value = useSensorStore.getState().getSensorValue('PT.PT_CH1', 'raw_adc_counts');
    expect(value).toBe(1234567);
  });
});

// ── Test 3: State transitions → store ────────────────────────────────────────

describe('State transitions → store', () => {
  it('should update currentState from STATE_UPDATE', () => {
    const { updateState } = useSensorStore.getState();

    updateState({
      currentState: SystemState.ARMED,
      stateName: 'ARMED',
      timestamp: Date.now(),
    });

    expect(useSensorStore.getState().currentState).toBe(SystemState.ARMED);
  });

  it('should clear actuator overrides on state change', () => {
    const { setActuatorCommandedOverride, updateState } = useSensorStore.getState();

    setActuatorCommandedOverride('ACT.LOX_Main', ActuatorState.OPEN);
    expect(useSensorStore.getState().actuatorCommandedOverrides['ACT.LOX_Main']).toBe(ActuatorState.OPEN);

    updateState({
      currentState: SystemState.ARMED,
      stateName: 'ARMED',
      timestamp: Date.now(),
    });

    expect(Object.keys(useSensorStore.getState().actuatorCommandedOverrides)).toHaveLength(0);
  });

  it('should handle all valid state transitions', () => {
    const { updateState } = useSensorStore.getState();

    const states = [
      SystemState.IDLE,
      SystemState.ARMED,
      SystemState.FUEL_FILL,
      SystemState.READY,
      SystemState.FIRE,
      SystemState.ENGINE_ABORT,
      SystemState.IDLE,
    ];

    for (const state of states) {
      updateState({ currentState: state, stateName: SystemState[state], timestamp: Date.now() });
      expect(useSensorStore.getState().currentState).toBe(state);
    }
  });

  it('should handle emergency abort states', () => {
    const { updateState } = useSensorStore.getState();

    updateState({ currentState: SystemState.EMERGENCY_ABORT, stateName: 'EMERGENCY_ABORT', timestamp: Date.now() });
    expect(useSensorStore.getState().currentState).toBe(SystemState.EMERGENCY_ABORT);

    updateState({ currentState: SystemState.GSE_ABORT, stateName: 'GSE_ABORT', timestamp: Date.now() });
    expect(useSensorStore.getState().currentState).toBe(SystemState.GSE_ABORT);
  });
});

// ── Test 4: Actuator updates → store ─────────────────────────────────────────

describe('Actuator updates → store', () => {
  it('should update actuator state from ACTUATOR_UPDATE', () => {
    const { updateActuator } = useSensorStore.getState();

    updateActuator({
      actuatorId: 0, // LOX_MAIN
      name: 'LOX_Main',
      state: ActuatorState.OPEN,
      rawAdcCounts: 1500000,
      timestamp: Date.now(),
    });

    const state = useSensorStore.getState();
    expect(state.actuatorStateByEntity['ACT.LOX_Main']).toBe(ActuatorState.OPEN);
  });

  it('should track multiple actuator states independently', () => {
    const { updateActuator } = useSensorStore.getState();

    updateActuator({
      actuatorId: 0,
      name: 'LOX_Main',
      state: ActuatorState.OPEN,
      rawAdcCounts: 1500000,
      timestamp: Date.now(),
    });

    updateActuator({
      actuatorId: 3,
      name: 'Fuel_Vent',
      state: ActuatorState.CLOSED,
      rawAdcCounts: 500000,
      timestamp: Date.now(),
    });

    const state = useSensorStore.getState();
    expect(state.actuatorStateByEntity['ACT.LOX_Main']).toBe(ActuatorState.OPEN);
    expect(state.actuatorStateByEntity['ACT.Fuel_Vent']).toBe(ActuatorState.CLOSED);
  });
});

// ── Test 5: Expected actuator positions per state ────────────────────────────

describe('Expected actuator positions per state', () => {
  it('should store expected positions from backend', () => {
    const { updateActuatorExpectedPositions } = useSensorStore.getState();

    updateActuatorExpectedPositions({
      [SystemState.ARMED]: {
        'ACT.LOX_Main': 'closed',
        'ACT.Fuel_Main': 'closed',
        'ACT.LOX_Vent': 'open',
      },
    });

    const state = useSensorStore.getState();
    const armedPositions = state.actuatorExpectedPositions[SystemState.ARMED];
    expect(armedPositions['ACT.LOX_Main']).toBe('closed');
    expect(armedPositions['ACT.Fuel_Main']).toBe('closed');
    expect(armedPositions['ACT.LOX_Vent']).toBe('open');
  });
});
