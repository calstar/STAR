import { describe, it, expect, beforeEach } from 'vitest';
import { rawToDeg, detectTransition } from '@/components/plots/OscopeTriggerPlot';
import { useSensorStore } from '@/lib/store';
import { SystemState } from '@/lib/types';

describe('rawToDeg — AS5600 12-bit angle conversion', () => {
    it('should convert 0 to 0 degrees', () => {
        expect(rawToDeg(0)).toBe(0);
    });

    it('should convert 2048 to 180 degrees', () => {
        expect(rawToDeg(2048)).toBeCloseTo(180.0, 1);
    });

    it('should convert 4095 to ≈359.91 degrees', () => {
        expect(rawToDeg(4095)).toBeCloseTo(359.912, 1);
    });

    it('should convert 1024 to 90 degrees', () => {
        expect(rawToDeg(1024)).toBeCloseTo(90.0, 1);
    });

    it('should convert 3072 to 270 degrees', () => {
        expect(rawToDeg(3072)).toBeCloseTo(270.0, 1);
    });

    it('should mask to 12 bits (ignore upper bits)', () => {
        // 0xF000 | 1024 = 0xF400, but only lower 12 bits (0x400 = 1024) matter
        expect(rawToDeg(0xF000 | 1024)).toBeCloseTo(90.0, 1);
    });

    it('should handle full 12-bit range boundary', () => {
        // 4096 wraps to 0 because of 0x0FFF mask
        expect(rawToDeg(4096)).toBe(0);
    });
});

describe('detectTransition — step detection algorithm', () => {
    it('should return null for fewer than 4 samples', () => {
        expect(detectTransition([0, 1, 2], [10, 50, 90])).toBeNull();
    });

    it('should detect a rising 90-degree step', () => {
        // Simulate: 100ms at 0°, transition at 500ms, 100ms at 90°
        const times: number[] = [];
        const values: number[] = [];
        for (let t = 0; t <= 200; t += 10) { times.push(t); values.push(0); }
        for (let t = 210; t <= 290; t += 10) { times.push(t); values.push((t - 200) * 1.0); }
        for (let t = 300; t <= 500; t += 10) { times.push(t); values.push(90); }

        const result = detectTransition(times, values);
        expect(result).not.toBeNull();
        expect(result!.angleDelta).toBeCloseTo(90, 0);
        expect(result!.prePlateau).toBeCloseTo(0, 0);
        expect(result!.postPlateau).toBeCloseTo(90, 0);
        expect(result!.timeMsRel).toBeGreaterThan(200);
        expect(result!.timeMsRel).toBeLessThan(300);
    });

    it('should detect a falling step', () => {
        const times: number[] = [];
        const values: number[] = [];
        for (let t = 0; t <= 200; t += 10) { times.push(t); values.push(270); }
        for (let t = 210; t <= 290; t += 10) { times.push(t); values.push(270 - (t - 200) * 1.0); }
        for (let t = 300; t <= 500; t += 10) { times.push(t); values.push(180); }

        const result = detectTransition(times, values);
        expect(result).not.toBeNull();
        expect(result!.angleDelta).toBeCloseTo(90, 0);
        expect(result!.prePlateau).toBeCloseTo(270, 0);
        expect(result!.postPlateau).toBeCloseTo(180, 0);
    });

    it('should return null for flat signal (no transition)', () => {
        const times = Array.from({ length: 50 }, (_, i) => i * 10);
        const values = times.map(() => 45.0);
        expect(detectTransition(times, values)).toBeNull();
    });

    it('should return null for small angle change below threshold', () => {
        const times: number[] = [];
        const values: number[] = [];
        for (let t = 0; t <= 200; t += 10) { times.push(t); values.push(10); }
        for (let t = 210; t <= 500; t += 10) { times.push(t); values.push(20); }

        // 10-degree change is below threshold (45 * 0.5 = 22.5)
        expect(detectTransition(times, values)).toBeNull();
    });

    it('should use linear interpolation for sub-sample midpoint crossing', () => {
        const times: number[] = [];
        const values: number[] = [];
        for (let t = 0; t <= 200; t += 10) { times.push(t); values.push(0); }
        // Big jump from 0 to 90 in one step at t=250
        times.push(250); values.push(0);
        times.push(260); values.push(90);
        for (let t = 270; t <= 500; t += 10) { times.push(t); values.push(90); }

        const result = detectTransition(times, values);
        expect(result).not.toBeNull();
        // Midpoint is 45. Linear interp between (250, 0) and (260, 90):
        // frac = (45 - 0) / (90 - 0) = 0.5, crossTime = 250 + 0.5 * 10 = 255
        expect(result!.timeMsRel).toBeCloseTo(255, 0);
    });
});

describe('Encoder sensor data through store', () => {
    beforeEach(() => {
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

    it('should store encoder raw_angle values', async () => {
        const { updateSensor } = useSensorStore.getState();

        updateSensor({
            entity: 'ENC.CH1',
            component: 'raw_angle',
            value: 2048,
            timestamp: Date.now(),
        });

        updateSensor({
            entity: 'ENC.CH2',
            component: 'raw_angle',
            value: 1024,
            timestamp: Date.now(),
        });

        await new Promise(resolve => setTimeout(resolve, 60));

        const data = useSensorStore.getState().sensorData;
        expect(data['ENC.CH1.raw_angle']).toBe(2048);
        expect(data['ENC.CH2.raw_angle']).toBe(1024);
    });

    it('should reject late encoder packets', async () => {
        const { updateSensor } = useSensorStore.getState();
        const now = Date.now();

        updateSensor({ entity: 'ENC.CH1', component: 'raw_angle', value: 100, timestamp: now });
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(useSensorStore.getState().sensorData['ENC.CH1.raw_angle']).toBe(100);

        // Older packet should be rejected
        updateSensor({ entity: 'ENC.CH1', component: 'raw_angle', value: 50, timestamp: now - 5000 });
        await new Promise(resolve => setTimeout(resolve, 60));
        expect(useSensorStore.getState().sensorData['ENC.CH1.raw_angle']).toBe(100);
    });
});
