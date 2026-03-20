import { describe, it, expect } from 'vitest';
import { parseElodinPacket } from '../elodin-protocol.js';

/** Build a 21-byte RawPTMessage buffer (shared layout for PT/TC/RTD/LC/Encoder). */
function buildRawSensorPayload(
    timestampNs: bigint,
    channelId: number,
    rawValue: number,
    sampleTimestampMs: number = 0,
    statusFlags: number = 0,
): Buffer {
    const buf = Buffer.alloc(21);
    buf.writeBigUInt64LE(timestampNs, 0);
    buf.writeUInt8(channelId, 8);
    buf.writeUInt32LE(rawValue, 12);
    buf.writeUInt32LE(sampleTimestampMs, 16);
    buf.writeUInt8(statusFlags, 20);
    return buf;
}

describe('elodin-protocol parseElodinPacket — Encoder', () => {
    it('should parse encoder channel 1 raw angle', () => {
        const rawAngle = 2048; // midpoint of 12-bit range (180 degrees)
        const buf = buildRawSensorPayload(10000000000n, 1, rawAngle);
        const results = parseElodinPacket([0x24, 0x01], buf);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            entity: 'ENC.CH1',
            component: 'raw_angle',
            value: 2048,
            timestamp: 10000,
        });
    });

    it('should parse encoder channel 2 raw angle', () => {
        const rawAngle = 4095; // max 12-bit value (≈359.9 degrees)
        const buf = buildRawSensorPayload(5000000000n, 2, rawAngle);
        const results = parseElodinPacket([0x24, 0x02], buf);

        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            entity: 'ENC.CH2',
            component: 'raw_angle',
            value: 4095,
            timestamp: 5000,
        });
    });

    it('should parse encoder zero-angle correctly', () => {
        const buf = buildRawSensorPayload(1000000000n, 1, 0);
        const results = parseElodinPacket([0x24, 0x01], buf);

        expect(results).toHaveLength(1);
        expect(results[0]!.value).toBe(0);
    });

    it('should return empty array for encoder payload too short', () => {
        const buf = Buffer.alloc(10); // less than 21 bytes
        const results = parseElodinPacket([0x24, 0x01], buf);
        expect(results).toHaveLength(0);
    });

    it('should not match encoder for channel outside 1-2 range', () => {
        const buf = buildRawSensorPayload(1000000000n, 3, 100);
        const results = parseElodinPacket([0x24, 0x03], buf);
        expect(results).toHaveLength(0);
    });

    it('should not match encoder for wrong high byte', () => {
        const buf = buildRawSensorPayload(1000000000n, 1, 100);
        const results = parseElodinPacket([0x25, 0x01], buf);
        expect(results).toHaveLength(0);
    });

    it('should read raw value as unsigned (encoder ADC is unsigned)', () => {
        // 0xFFFFFFFF as unsigned = 4294967295, not -1
        const buf = buildRawSensorPayload(1000000000n, 1, 0xFFFFFFFF);
        const results = parseElodinPacket([0x24, 0x01], buf);

        expect(results).toHaveLength(1);
        expect(results[0]!.value).toBe(4294967295);
        expect(results[0]!.value).toBeGreaterThan(0);
    });
});

describe('elodin-protocol parseElodinPacket — Self-Test', () => {
    it('should parse 0x60 SELF_TEST results correctly', () => {
        // Layout: U64(0) timestamp_ns | U8(8) sensor_id | U8(9) result
        const buffer = Buffer.alloc(10);

        // timestamp = 5,000,000,000 ns -> 5000 ms
        buffer.writeBigUInt64LE(5000000000n, 0);
        buffer.writeUInt8(4, 8); // sensor_id = 4
        buffer.writeUInt8(1, 9); // result = 1 (pass)

        const boardId = 12; // Board 12
        const packetId: [number, number] = [0x60, boardId];

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
        const packetId: [number, number] = [0x60, boardId];

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
