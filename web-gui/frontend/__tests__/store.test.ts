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
});
