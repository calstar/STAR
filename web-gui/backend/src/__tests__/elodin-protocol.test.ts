import { describe, it, expect } from 'vitest';
import { parseElodinPacket } from '../elodin-protocol.js';

describe('elodin-protocol parseElodinPacket', () => {
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
