import { describe, it, expect, beforeEach } from 'vitest';
import { useSensorStore } from '@/lib/store';
import { ActuatorId, ActuatorState, SystemState } from '@/lib/types';

describe('useSensorStore', () => {
    beforeEach(() => {
        // Reset store before each test
        useSensorStore.setState({
            sensorData: {},
            actuators: new Map(),
            currentState: SystemState.IDLE,
            actuatorStateByEntity: {},
            actuatorCommandedOverrides: {},
            actuatorExpectedPositions: {},
            debugMode: false,
        });
    });

    it('should update actuator state globally', () => {
        const { setActuatorState } = useSensorStore.getState();
        setActuatorState('ACT.LOX_Main', ActuatorState.OPEN);
        expect(useSensorStore.getState().actuatorStateByEntity['ACT.LOX_Main']).toBe(ActuatorState.OPEN);
    });

    it('should clear overrides when leaving debug mode', () => {
        const { setDebugMode, setActuatorCommandedOverride } = useSensorStore.getState();
        setDebugMode(true);
        setActuatorCommandedOverride('ACT.Fuel_Vent', ActuatorState.OPEN);
        expect(useSensorStore.getState().actuatorCommandedOverrides['ACT.Fuel_Vent']).toBe(ActuatorState.OPEN);

        setDebugMode(false);
        expect(useSensorStore.getState().actuatorCommandedOverrides['ACT.Fuel_Vent']).toBeUndefined();
    });

    it('should update current state and reset overrides', () => {
        const { updateState, setActuatorCommandedOverride } = useSensorStore.getState();
        setActuatorCommandedOverride('ACT.LOX_Main', ActuatorState.OPEN);
        updateState({ currentState: SystemState.ARMED, stateName: 'ARMED', timestamp: Date.now() });

        expect(useSensorStore.getState().currentState).toBe(SystemState.ARMED);
        expect(Object.keys(useSensorStore.getState().actuatorCommandedOverrides)).toHaveLength(0);
    });

    it('should update connection status', () => {
        const { updateConnectionStatus } = useSensorStore.getState();
        updateConnectionStatus({ connected: true, elodinConnected: true });

        const state = useSensorStore.getState();
        expect(state.connectionStatus.connected).toBe(true);
        expect(state.connectionStatus.elodinConnected).toBe(true);
    });

    it('should update mission start time', () => {
        const { updateMissionStartTime } = useSensorStore.getState();
        const time = Date.now();
        updateMissionStartTime(time);

        expect(useSensorStore.getState().missionStartTime).toBe(time);
    });

    it('should update expected actuator positions and deep merge', () => {
        const { updateActuatorExpectedPositions } = useSensorStore.getState();

        // First update
        updateActuatorExpectedPositions({
            [SystemState.IDLE]: { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed' },
        });

        // Second update adds more positions
        updateActuatorExpectedPositions({
            [SystemState.ARMED]: { 'ACT.LOX_Vent': 'open' },
        });

        const state = useSensorStore.getState();
        expect(state.actuatorExpectedPositions[SystemState.IDLE]['ACT.LOX_Main']).toBe('closed');
        expect(state.actuatorExpectedPositions[SystemState.ARMED]['ACT.LOX_Vent']).toBe('open');
    });

    it('should handle debug mode toggle with actuator override preservation', () => {
        const { setDebugMode, setActuatorCommandedOverride } = useSensorStore.getState();

        setDebugMode(true);
        expect(useSensorStore.getState().debugMode).toBe(true);

        setActuatorCommandedOverride('ACT.LOX_Main', ActuatorState.OPEN);

        // Toggling debug on again should preserve overrides
        setDebugMode(true);
        expect(useSensorStore.getState().actuatorCommandedOverrides['ACT.LOX_Main']).toBe(ActuatorState.OPEN);
    });

    it('should remove override when set to null', () => {
        const { setDebugMode, setActuatorCommandedOverride } = useSensorStore.getState();
        setDebugMode(true);

        setActuatorCommandedOverride('ACT.LOX_Main', ActuatorState.OPEN);
        expect(useSensorStore.getState().actuatorCommandedOverrides['ACT.LOX_Main']).toBe(ActuatorState.OPEN);

        setActuatorCommandedOverride('ACT.LOX_Main', null);
        expect(useSensorStore.getState().actuatorCommandedOverrides['ACT.LOX_Main']).toBeUndefined();
    });

    it('should buffer and flush SELF_TEST sensor updates', async () => {
        const { updateSensor } = useSensorStore.getState();

        updateSensor({
            entity: 'SELF_TEST.BOARD_1',
            component: 'sensor_2',
            value: 1,
            timestamp: Date.now()
        });

        updateSensor({
            entity: 'SELF_TEST.BOARD_1',
            component: 'sensor_3',
            value: 0,
            timestamp: Date.now()
        });

        // Wait for 50ms flush interval
        await new Promise(resolve => setTimeout(resolve, 60));

        const data = useSensorStore.getState().sensorData;
        expect(data['SELF_TEST.BOARD_1.sensor_2']).toBe(1);
        expect(data['SELF_TEST.BOARD_1.sensor_3']).toBe(0);
    });
});
