import { describe, it, expect } from 'vitest';
import { parseElodinPacket } from '../elodin-protocol.js';
describe('elodin-protocol HP PT board slot 2 (unsigned raw)', () => {
    it('parses PT2 raw ADC as uint32 (high bit set stays positive)', () => {
        const buf = Buffer.alloc(21);
        buf.writeBigUInt64LE(0n, 0);
        buf.writeUInt8(1, 8);
        const u = 0x90000000 >>> 0;
        buf.writeUInt32LE(u, 12);
        buf.writeUInt32LE(0, 16);
        buf.writeUInt8(0, 20);
        const out = parseElodinPacket([0x20, 0x21], buf);
        expect(out).toHaveLength(1);
        expect(out[0].entity).toBe('PT2.CH1');
        expect(out[0].value).toBe(u);
    });
    it('parses PT2 CalibratedPTMessage companion raw as uint32', () => {
        const buf = Buffer.alloc(21);
        buf.writeBigUInt64LE(1000000000n, 0);
        buf.writeUInt8(1, 8);
        buf.writeFloatLE(100.0, 12);
        const u = 0xa0000000 >>> 0;
        buf.writeUInt32LE(u, 16);
        buf.writeUInt8(1, 20);
        const out = parseElodinPacket([0x20, 0x31], buf);
        const raw = out.find((p) => p.component === 'raw_adc_counts');
        expect(raw.value).toBe(u);
    });
});
describe('elodin-protocol calibrated PT raw field (signed ADC)', () => {
    it('parses negative raw adc in CalibratedPTMessage as int32, not ~4e9', () => {
        const buf = Buffer.alloc(21);
        buf.writeBigUInt64LE(1000000000n, 0);
        buf.writeUInt8(1, 8);
        buf.writeFloatLE(150.0, 12);
        buf.writeInt32LE(-500_000, 16);
        buf.writeUInt8(1, 20);
        const out = parseElodinPacket([0x20, 0x11], buf);
        const raw = out.find((p) => p.component === 'raw_adc_counts');
        expect(raw).toBeDefined();
        expect(raw.value).toBe(-500_000);
        const psi = out.find((p) => p.component === 'pressure_psi');
        expect(psi.value).toBeCloseTo(150.0, 5);
    });
});
describe('elodin-protocol TC calibrated temperature_c', () => {
    it('accepts TC1 cal channel 2 with temp 150°C (board-scoped entity)', () => {
        const buf = Buffer.alloc(21);
        buf.writeBigUInt64LE(1000000000n, 0);
        buf.writeUInt8(2, 8);
        buf.writeFloatLE(150.0, 12);
        buf.writeInt32LE(9_800_000, 16);
        buf.writeUInt8(1, 20);
        // low 0x12 = board 1, cal ch2
        const out = parseElodinPacket([0x21, 0x12], buf);
        const t = out.find((p) => p.entity === 'TC1_Cal.CH2' && p.component === 'temperature_c');
        expect(t).toBeDefined();
        expect(t.value).toBeCloseTo(150.0, 5);
    });
    it('rejects absurd temperature_c (>10000) as garbage', () => {
        const buf = Buffer.alloc(21);
        buf.writeBigUInt64LE(1n, 0);
        buf.writeUInt8(2, 8);
        buf.writeFloatLE(9_800_000.0, 12);
        buf.writeInt32LE(0, 16);
        buf.writeUInt8(0, 20);
        const out = parseElodinPacket([0x21, 0x12], buf);
        const t = out.find((p) => p.component === 'temperature_c');
        expect(t).toBeUndefined();
    });
});
describe('elodin-protocol parseElodinPacket', () => {
    it('should parse 0x60 SELF_TEST results correctly', () => {
        // Layout: U64(0) timestamp_ns | U8(8) sensor_id | U8(9) result
        const buffer = Buffer.alloc(10);
        // timestamp = 5,000,000,000 ns -> 5000 ms
        buffer.writeBigUInt64LE(5000000000n, 0);
        buffer.writeUInt8(4, 8); // sensor_id = 4
        buffer.writeUInt8(1, 9); // result = 1 (pass)
        const boardId = 12; // Board 12
        const packetId = [0x60, boardId];
        const results = parseElodinPacket(packetId, buffer);
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            entity: 'SELF_TEST.BOARD_12',
            component: 'sensor_4',
            value: 1,
            timestamp: 5000
        });
    });
    it('should parse 0x60 SELF_TEST result = fail', () => {
        const buffer = Buffer.alloc(10);
        buffer.writeBigUInt64LE(1234567000000n, 0); // 1234567 ms
        buffer.writeUInt8(0, 8); // sensor_id = 0
        buffer.writeUInt8(0, 9); // result = 0 (fail)
        const boardId = 2;
        const packetId = [0x60, boardId];
        const results = parseElodinPacket(packetId, buffer);
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            entity: 'SELF_TEST.BOARD_2',
            component: 'sensor_0',
            value: 0,
            timestamp: 1234567
        });
    });
    it('should return empty array for 0x60 if payload is too short', () => {
        const buffer = Buffer.alloc(5); // Too short
        const results = parseElodinPacket([0x60, 1], buffer);
        expect(results).toHaveLength(0);
    });
});
