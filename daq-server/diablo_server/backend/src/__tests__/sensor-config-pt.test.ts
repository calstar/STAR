import { describe, it, expect } from 'vitest';
import { buildSensorConfig } from '../api-server.js';

// The stand's shape: PT board 21 samples connector 1 but [sensor_roles_pt_board] names only 3+.
const PT_BOARD = {
    type: 'PT', ip: '192.168.2.21', board_id: 21, enabled: true, voltage_reference: 1,
    active_connectors: [1, 3, 4],
};
const HP_BOARD = {
    type: 'PT', pt_type: '4-20 mA absolute', ip: '192.168.2.22', board_id: 22, enabled: true,
    voltage_reference: 0, adc_ref_voltage: 2.5, hp_pt_full_scale_psi: 5000,
    hp_pt_sense_resistor_ohms: 120, active_connectors: [1, 2],
};

describe('/api/sensor-config: PT connectors with no role', () => {
    it('lists an active connector no role names, under a generated board-scoped name', () => {
        const sensors = buildSensorConfig({
            boards: { pt_board: PT_BOARD, pt_board_2: HP_BOARD },
            sensor_roles_pt_board: { 'DR-PT-R': 3, 'LP-PT': 4 },
            sensor_roles_pt_board_2: { 'COPV-PT-R': 1 },
        });
        const pt = sensors.filter((s) => s.type === 'PT');
        expect(pt.map((s) => [s.boardId, s.id, s.role, s.entity, s.calEntity])).toEqual([
            [21, 1, 'PT21 Ch1', 'PT1.CH1', 'PT1_Cal.CH1'],
            [21, 3, 'DR-PT-R', 'PT1.CH3', 'PT1_Cal.CH3'],
            [21, 4, 'LP-PT', 'PT1.CH4', 'PT1_Cal.CH4'],
            [22, 1, 'COPV-PT-R', 'PT2.CH1', 'PT2_Cal.CH1'],
            [22, 2, 'PT22 Ch2', 'PT2.CH2', 'PT2_Cal.CH2'],
        ]);
    });

    it('keeps an unnamed channel out of calibration, and its board decides isHpPt', () => {
        const sensors = buildSensorConfig({
            boards: { pt_board: PT_BOARD, pt_board_2: HP_BOARD },
            sensor_roles_pt_board: { 'DR-PT-R': 3 },
            sensor_roles_pt_board_2: { 'COPV-PT-R': 1 },
        });
        const by = (b: number, c: number) => sensors.find((s) => s.boardId === b && s.id === c)!;
        expect(by(21, 1)).toMatchObject({ inCalibrationSequence: false, isHpPt: false });
        expect(by(21, 3)).toMatchObject({ inCalibrationSequence: true });
        expect(by(22, 2)).toMatchObject({ inCalibrationSequence: false, isHpPt: true });
    });

    it('uses the short name on a single-PT-board rig and never lists a named channel twice', () => {
        const sensors = buildSensorConfig({
            boards: { pt_board: PT_BOARD },
            sensor_roles_pt_board: { 'DR-PT-R': 3, 'LP-PT': 4 },
        });
        expect(sensors.map((s) => s.role)).toEqual(['PT Ch1', 'DR-PT-R', 'LP-PT']);
    });

    it('lists every active connector of a board with no roles section', () => {
        const sensors = buildSensorConfig({ boards: { pt_board: PT_BOARD } });
        expect(sensors.map((s) => s.role)).toEqual(['PT Ch1', 'PT Ch3', 'PT Ch4']);
    });
});
