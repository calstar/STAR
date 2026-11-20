/**
 * LabJack T7 channels reach the GUI as ordinary PT / TC / LC sensors.
 *
 * t7_bridge publishes each channel raw (volts, {0x26, (slot-1)*0x20 + ain}) and calibrated (psi /
 * °C / kg, +0x10). Pinned here: the backend subscribes exactly those tables, decodes them under
 * the ESP32 boards' field names, lists each PT/TC/LC channel by its role in /api/sensor-config,
 * and the session gate refuses the T7 configs t7_bridge would refuse.
 */
import { describe, it, expect } from 'vitest';
import { parse, stringify } from 'smol-toml';
import { buildVTableStreamSubscriptionList } from '../elodin-vtable-registry.js';
import { parseElodinPacket } from '../elodin-protocol.js';
import { t7CalFields } from '../sensor-config.js';
import { buildSensorConfig } from '../api-server.js';
import { applyCalibrationModelDefaults } from '../routes/config.js';
import { mapEntityToGroup, isPrimaryPhysicalStream } from '../board-scan-rate.js';
import { pipelineUnits, setT7UnitInstalledForTests, T7_UNIT } from '../service-controller.js';
import { t7Channels, t7BoardIssues, t7RoleClashes, validateConfigForRun } from '../../../shared/config-validation.js';

const T7_BOARD = {
    type: 'T7', ip: '192.168.2.82', board_id: 82, enabled: true, scan_rate_hz: 100,
    channels: [
        { ain: 1, kind: 'PT', role: 'LOX Tank', signal: '0-5V', full_scale: 1000 },
        { ain: 2, kind: 'TC', tc_type: 'K', role: 'Nozzle TC' },
        { ain: 4, kind: 'LC', role: 'Thrust', differential: true, range: 0.1, full_scale: 500,
          sensitivity_mv_per_v: 2, excitation_v: 10 },
        { ain: 6, kind: 'VOLTAGE' },
    ],
};

const CONFIG = {
    boards: {
        pt_board: { type: 'PT', ip: '192.168.2.21', board_id: 21, enabled: true, active_connectors: [1, 2] },
        labjack_1: T7_BOARD,
        labjack_off: { ...T7_BOARD, board_id: 83, enabled: false,
            channels: [{ ain: 3, kind: 'PT', role: 'Off PT', signal: '0-5V', full_scale: 100 }] },
    },
    sensor_roles_pt_board: { 'Fuel Upstream': 1, 'Fuel Downstream': 2 },
};

/** 21-byte sensor payload: u64 ns @0 | u8 ch @8 | pad | 4 bytes @12 | 4 bytes @16 | u8 @20. */
function payload(at12: (b: Buffer) => void, at16 = 0, ch = 0): Buffer {
    const b = Buffer.alloc(21);
    b.writeBigUInt64LE(1_700_000_000_123_000_000n, 0);
    b.writeUInt8(ch, 8);
    at12(b);
    b.writeInt32LE(at16, 16);
    b.writeUInt8(1, 20);
    return b;
}

describe('T7 channels from config', () => {
    it('lists each channel with the tables t7_bridge publishes it to', () => {
        const chs = t7Channels(CONFIG.boards).filter((c) => c.boardKey === 'labjack_1');
        const pt = chs.find((c) => c.ain === 1)!;
        // board_id 82 -> slot 2 -> block 0x20.
        expect(pt).toMatchObject({ slot: 2, rawLow: 0x21, calLow: 0x31, entity: 'T72.AIN1',
            calEntity: 'T72_Cal.AIN1', calField: 'pressure_psi', role: 'LOX Tank' });
        expect(chs.find((c) => c.ain === 6)).toMatchObject({ kind: 'VOLTAGE', calLow: null });
        // A TC on the board streams AIN14 (CJC), raw only.
        expect(chs.find((c) => c.ain === 14)).toMatchObject({ kind: 'CJC', rawLow: 0x2e, calLow: null });
    });

    it('a board with no thermocouple has no AIN14', () => {
        const chs = t7Channels({ lj: { ...T7_BOARD, channels: [T7_BOARD.channels[0]] } });
        expect(chs.map((c) => c.ain)).toEqual([1]);
    });
});

describe('subscriptions', () => {
    const pairs = buildVTableStreamSubscriptionList(CONFIG);
    const has = (h: number, l: number) => pairs.some(([a, b]) => a === h && b === l);

    it('subscribes raw and calibrated tables for each enabled T7 channel', () => {
        expect(has(0x26, 0x21) && has(0x26, 0x31)).toBe(true);  // PT AIN1
        expect(has(0x26, 0x22) && has(0x26, 0x32)).toBe(true);  // TC AIN2
        expect(has(0x26, 0x24) && has(0x26, 0x34)).toBe(true);  // LC AIN4
        expect(has(0x26, 0x26)).toBe(true);                       // VOLTAGE AIN6 raw
        expect(has(0x26, 0x36)).toBe(false);                      // ...which has no calibrated table
        expect(has(0x26, 0x2e)).toBe(true);                       // AIN14 CJC raw
    });

    it('subscribes nothing for a disabled T7', () => {
        expect(has(0x26, 0x43) || has(0x26, 0x53)).toBe(false);   // labjack_off: slot 3 (0x40) AIN3
    });

    it('registers no heartbeat or self-test for a T7 (it has neither)', () => {
        expect(has(0x10, 82) || has(0x60, 82)).toBe(false);
        expect(has(0x10, 21)).toBe(true);
    });

    it('a config whose only boards are T7s is not mistaken for an empty one', () => {
        const only = buildVTableStreamSubscriptionList({ boards: { labjack_1: T7_BOARD } });
        expect(only.some(([h, l]) => h === 0x20 && l === 0x11)).toBe(false);  // no dev fallback
        expect(only.some(([h, l]) => h === 0x26 && l === 0x31)).toBe(true);
    });
});

describe('decoding', () => {
    const fields = t7CalFields(CONFIG);

    it('decodes a raw T7 table to volts', () => {
        const out = parseElodinPacket([0x26, 0x21], payload((b) => b.writeFloatLE(2.5, 12)), undefined, fields);
        expect(out).toEqual([{ entity: 'T72.AIN1', component: 'volts', value: 2.5, timestamp: 1_700_000_000_123 }]);
    });

    it('decodes AIN0 and AIN14, which the ESP32 1-10 channel rule would drop', () => {
        expect(parseElodinPacket([0x26, 0x20], payload((b) => b.writeFloatLE(1, 12)))[0]?.entity).toBe('T72.AIN0');
        expect(parseElodinPacket([0x26, 0x2e], payload((b) => b.writeFloatLE(1.8, 12)))[0]?.entity).toBe('T72.AIN14');
    });

    it('decodes each calibrated table under the ESP32 field name for its kind', () => {
        const at = (low: number, v: number) =>
            parseElodinPacket([0x26, low], payload((b) => b.writeFloatLE(v, 12), 2_500_000), undefined, fields);
        expect(at(0x31, 500)).toEqual([
            { entity: 'T72_Cal.AIN1', component: 'pressure_psi', value: 500, timestamp: 1_700_000_000_123 },
            // The calibration code (µV for a T7) under the ESP32 boards' raw field names, so the
            // calibration views read it the same way.
            { entity: 'T72_Cal.AIN1', component: 'raw_adc_counts', value: 2_500_000, timestamp: 1_700_000_000_123 },
            { entity: 'T72_Cal.AIN1', component: 'raw_adc', value: 2_500_000, timestamp: 1_700_000_000_123 },
        ]);
        expect(at(0x32, 150)[0]).toMatchObject({ entity: 'T72_Cal.AIN2', component: 'temperature_c', value: 150 });
        expect(at(0x34, 125)[0]).toMatchObject({ entity: 'T72_Cal.AIN4', component: 'force_kg', value: 125 });
    });

    it('drops a calibrated T7 table it has no field for, rather than guess the unit', () => {
        expect(parseElodinPacket([0x26, 0x31], payload((b) => b.writeFloatLE(500, 12)))).toEqual([]);
        expect(parseElodinPacket([0x26, 0x36], payload((b) => b.writeFloatLE(1, 12)), undefined, fields)).toEqual([]);
    });

    it('applies the same garbage bounds as the ESP32 tables', () => {
        const out = parseElodinPacket([0x26, 0x31], payload((b) => b.writeFloatLE(1e9, 12)), undefined, fields);
        expect(out).toEqual([]);
    });

    it('groups a T7 as one board for scan-rate diagnostics, counting the raw volts once', () => {
        expect(mapEntityToGroup('T72.AIN1')).toBe('t72');
        expect(mapEntityToGroup('T72_Cal.AIN1')).toBe('t72');
        expect(isPrimaryPhysicalStream('T72.AIN1', 'volts')).toBe(true);
        expect(isPrimaryPhysicalStream('T72_Cal.AIN1', 'pressure_psi')).toBe(false);
    });
});

describe('/api/sensor-config', () => {
    const sensors = buildSensorConfig(CONFIG);
    const t7 = sensors.filter((s) => s.source === 'T7');

    it('lists each T7 PT / TC / LC channel as a sensor of that type, named by its role', () => {
        expect(t7.map((s) => [s.type, s.role, s.calEntity])).toEqual([
            ['PT', 'LOX Tank', 'T72_Cal.AIN1'],
            ['TC', 'Nozzle TC', 'T72_Cal.AIN2'],
            ['LC', 'Thrust', 'T72_Cal.AIN4'],
        ]);
        expect(t7[0]).toMatchObject({ id: 1, boardId: 82, boardIp: '192.168.2.82', entity: 'T72.AIN1' });
    });

    it('beside the ESP32 sensors, which are unchanged', () => {
        expect(sensors.filter((s) => s.source === undefined).map((s) => s.role))
            .toEqual(['Fuel Upstream', 'Fuel Downstream']);
    });

    it('lists no VOLTAGE channel, no AIN14 and nothing from a disabled T7', () => {
        expect(t7.some((s) => s.id === 6 || s.id === 14 || s.role === 'Off PT')).toBe(false);
    });

    it('puts T7 PT and LC inputs in the calibration sequence, like the ESP32 ones', () => {
        expect(t7.map((s) => [s.type, s.inCalibrationSequence])).toEqual([
            ['PT', true], ['TC', false], ['LC', true],
        ]);
    });
});

describe('RTD on an LJTick-Resistance', () => {
    const rtd = { ain: 3, kind: 'RTD', role: 'LOX RTD', r0_ohms: 1000, ljtr_ohms: 1000 };
    const boards = { labjack_1: { ...T7_BOARD, channels: [...T7_BOARD.channels, rtd] } };

    it('is listed as an RTD sensor under its role, publishing temperature_c', () => {
        const ch = t7Channels(boards).find((c) => c.role === 'LOX RTD');
        expect(ch).toMatchObject({ kind: 'RTD', calEntity: 'T72_Cal.AIN3', calField: 'temperature_c' });
        const s = buildSensorConfig({ boards }).find((x) => x.role === 'LOX RTD');
        expect(s).toMatchObject({ type: 'RTD', calEntity: 'T72_Cal.AIN3', source: 'T7', inCalibrationSequence: false });
    });

    it('decodes its calibrated table as temperature_c', () => {
        expect(t7CalFields({ boards }).get(0x20 + 0x10 + 3)).toBe('temperature_c');
    });
});

describe('session gate', () => {
    const issuesFor = (board: any, extra: Record<string, any> = {}) =>
        validateConfigForRun({ boards: { labjack_1: board }, ...extra })
            .filter((i) => i.level === 'error').map((i) => i.message);

    it('passes a valid T7', () => {
        expect(t7BoardIssues({ labjack_1: T7_BOARD }, 'labjack_1')).toEqual([]);
        expect(issuesFor(T7_BOARD)).toEqual([]);
    });

    // The same refusals as lib/src/config/T7Config.cpp.
    const cases: Array<[string, any, string]> = [
        ['a duplicate AIN', { channels: [T7_BOARD.channels[0], { ...T7_BOARD.channels[1], ain: 1 }] }, 'AIN1 is already used'],
        ['a PT with no full_scale', { channels: [{ ain: 1, kind: 'PT', role: 'A', signal: '0-5V' }] }, 'needs full_scale'],
        ['a 4-20mA PT with no shunt', { channels: [{ ain: 1, kind: 'PT', role: 'A', signal: '4-20mA', full_scale: 1 }] }, 'needs shunt_ohms'],
        ['an LC with no excitation', { channels: [{ ain: 1, kind: 'LC', role: 'A', full_scale: 1, sensitivity_mv_per_v: 2 }] }, 'needs excitation_v'],
        ['a type J thermocouple', { channels: [{ ain: 1, kind: 'TC', role: 'A', tc_type: 'J' }] }, 'only type K'],
        ['a channel with no role', { channels: [{ ain: 1, kind: 'TC', tc_type: 'K' }] }, 'needs a role'],
        ['an odd differential AIN', { channels: [{ ...T7_BOARD.channels[2], ain: 3 }] }, 'must be an even AIN'],
        ['a range the T7 lacks', { channels: [{ ...T7_BOARD.channels[0], range: 5 }] }, 'range must be one of'],
        ['AIN14', { channels: [{ ...T7_BOARD.channels[0], ain: 14 }] }, 'ain must be 0-13'],
        ['no channels', { channels: [] }, 'at least one channel'],
        ['an RTD with no element', { channels: [{ ain: 3, kind: 'RTD', role: 'R', ljtr_ohms: 1000 }] }, 'needs r0_ohms'],
        ['an RTD with no LJTick-Resistance', { channels: [{ ain: 3, kind: 'RTD', role: 'R', r0_ohms: 1000 }] }, 'needs ljtr_ohms'],
        ['an RTD on a range below the tick\'s 2.5 V', { channels: [{ ain: 3, kind: 'RTD', role: 'R', r0_ohms: 1000, ljtr_ohms: 1000, range: 1 }] }, 'must cover vref_v'],
        ['RTD settings on a PT', { channels: [{ ...T7_BOARD.channels[0], r0_ohms: 100 }] }, 'only meaningful on an RTD'],
        // Stream limits, datasheet A-1-1 (mirrors stream_limit_issues in T7Config.cpp).
        ['0.01 V in a multi-channel stream', { channels: [{ ...T7_BOARD.channels[2], range: 0.01 }, T7_BOARD.channels[0]] }, '0.01 V is not supported'],
        ['0.1 V in a multi-channel stream above res 2', { resolution_index: 3 }, '0.1 V is not supported'],
        ['two 1 V channels faster than 2 x 210 us', { scan_rate_hz: 3000, channels: [{ ...T7_BOARD.channels[0], range: 1 }, { ...T7_BOARD.channels[3], range: 1 }] }, 'beyond what this scan list'],
        ['one channel at res 8 past 600 scans/s', { resolution_index: 8, scan_rate_hz: 1000, channels: [T7_BOARD.channels[0]] }, 'at most 600'],
    ];
    for (const [what, patch, needle] of cases) {
        it(`refuses ${what}`, () => {
            const msgs = issuesFor({ ...T7_BOARD, ...patch });
            expect(msgs.some((m) => m.includes(needle)), msgs.join('\n')).toBe(true);
        });
    }

    it('passes a lone 0.01 V channel, and a TC board at 400 Hz (the 250 Hz sensor limit is the T8\'s)', () => {
        expect(issuesFor({ ...T7_BOARD, channels: [{ ...T7_BOARD.channels[2], range: 0.01 }] })).toEqual([]);
        expect(issuesFor({ ...T7_BOARD, scan_rate_hz: 400 })).toEqual([]);
    });

    it('passes an RTD on an LJTick-Resistance', () => {
        const rtd = { ain: 3, kind: 'RTD', role: 'LOX RTD', r0_ohms: 1000, ljtr_ohms: 1000 };
        expect(issuesFor({ ...T7_BOARD, channels: [...T7_BOARD.channels, rtd] })).toEqual([]);
    });

    it('refuses a T7 role that an ESP32 sensor already has', () => {
        const msgs = issuesFor(T7_BOARD, {
            boards: { pt_board: CONFIG.boards.pt_board, labjack_1: T7_BOARD },
            sensor_roles_pt_board: { 'LOX Tank': 1 },
        });
        expect(msgs.some((m) => m.includes('"LOX Tank" is also a sensor'))).toBe(true);
    });

    it('survives the config editor\'s TOML round trip (10.0 is written back as 10)', () => {
        const text = stringify({ boards: { labjack_1: T7_BOARD } });
        const back = parse(text) as any;
        expect(back.boards.labjack_1.channels).toHaveLength(4);
        expect(t7BoardIssues(back.boards, 'labjack_1')).toEqual([]);
    });
});

describe('session pipeline', () => {
    it('runs sensor-t7 with the pipeline where its unit is installed', () => {
        setT7UnitInstalledForTests(() => true);
        expect(pipelineUnits(false)).toContain(T7_UNIT);
        expect(pipelineUnits(true)).toContain(T7_UNIT);
    });

    it('leaves it out where it is not, so systemctl is never asked about an unknown unit', () => {
        // systemctl --user start/stop fails outright on a unit it does not know, which would
        // fail every session start on a box whose install_services.sh predates sensor-t7.
        setT7UnitInstalledForTests(() => false);
        expect(pipelineUnits(true)).not.toContain(T7_UNIT);
        expect(pipelineUnits(false)).toEqual(
            ['sensor-elodin', 'sensor-daq', 'sensor-calibration', 'sensor-controller', 'sensor-actuator']);
    });
});

describe('calibration models', () => {
    it('defaults each T7 PT / LC role to physics, in calibration_model_<t7 board>', () => {
        const cfg: any = JSON.parse(JSON.stringify(CONFIG));
        cfg.calibration_model_labjack_1 = { 'LOX Tank': 'cubic' };
        applyCalibrationModelDefaults(cfg);
        expect(cfg.calibration_model_labjack_1).toEqual({ 'LOX Tank': 'cubic', Thrust: 'physics' });
        // No entry for the TC or the VOLTAGE input: they have no model to choose.
        expect(Object.keys(cfg.calibration_model_labjack_1)).not.toContain('Nozzle TC');
    });
});

describe('role clashes', () => {
    it('names each T7 input whose role an ESP32 sensor already has, for the T7 card', () => {
        const clashes = t7RoleClashes({ ...CONFIG, sensor_roles_pt_board: { 'LOX Tank': 1 } });
        expect(clashes.map((c) => [c.boardKey, c.ain])).toEqual([['labjack_1', 1]]);
        expect(t7RoleClashes(CONFIG)).toEqual([]);
    });
});
