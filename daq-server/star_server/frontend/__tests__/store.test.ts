import { describe, it, expect, beforeEach } from 'vitest';
import { useSensorStore } from '@/lib/store';
import { ActuatorState, SystemState } from '@/lib/types';
import { waitForSensorFlush } from './waitForSensorFlush';

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

        await waitForSensorFlush();

        const data = useSensorStore.getState().sensorData;
        expect(data['SELF_TEST.BOARD_1.sensor_2']).toBe(1);
        expect(data['SELF_TEST.BOARD_1.sensor_3']).toBe(0);
    });
});
