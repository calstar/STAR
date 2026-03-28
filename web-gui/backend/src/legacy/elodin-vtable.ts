/**
 * VTable Registration for Elodin DB
 * Registers VTables so Elodin DB knows how to stream data to us
 */

import { ElodinClient, ElodinPacketType } from '../elodin-client.js';

/**
 * Register VTables with Elodin DB and subscribe to data streams
 *
 * NOTE: DAQ Bridge already registers VTables with Elodin DB.
 * Elodin DB requires explicit subscription via VTableStream messages
 * to start streaming TABLE packets to clients.
 *
 * VTableStream struct (from db.hpp):
 *   struct VTableStream {
 *     std::tuple<uint8_t, uint8_t> id;  // packet_id [high, low]
 *   }
 *
 * Postcard encoding: u8(high) + u8(low)
 */

export async function registerVTables(client: ElodinClient): Promise<boolean> {
  if (!client.isConnected()) {
    console.warn('⚠️ Cannot register VTables - Elodin client not connected');
    return false;
  }

  console.log('📡 Trying VTableStream subscriptions...');
  console.log('   VTableStream has structure: std::tuple<uint8_t, uint8_t> msg_id');
  console.log('');

  try {
    // All packet IDs we want to subscribe to
    const subscriptions: Array<[number, number]> = [
      // PT Raw channels (0x20, 0x01-0x0A) — PT board 1
      [0x20, 0x01], [0x20, 0x02], [0x20, 0x03], [0x20, 0x04], [0x20, 0x05],
      [0x20, 0x06], [0x20, 0x07], [0x20, 0x08], [0x20, 0x09], [0x20, 0x0A],
      // PT Raw channels (0x20, 0x0B-0x0E) — PT board 2 channels 11-14
      [0x20, 0x0B], [0x20, 0x0C], [0x20, 0x0D], [0x20, 0x0E],
      // PT Calibrated (0x20, 0x11-0x1E) — written by calibration_server.py, carries float32 PSI
      [0x20, 0x11], [0x20, 0x12], [0x20, 0x13], [0x20, 0x14], [0x20, 0x15],
      [0x20, 0x16], [0x20, 0x17], [0x20, 0x18], [0x20, 0x19], [0x20, 0x1A],
      [0x20, 0x1B], [0x20, 0x1C], [0x20, 0x1D], [0x20, 0x1E],
      [0x21, 0x01], [0x21, 0x02], [0x21, 0x03], [0x21, 0x04], [0x21, 0x05],
      [0x21, 0x06], [0x21, 0x07], [0x21, 0x08], [0x21, 0x09], [0x21, 0x0A],
      [0x21, 0x0B], [0x21, 0x0C], [0x21, 0x0D], [0x21, 0x0E], [0x21, 0x0F], [0x21, 0x10],
      [0x21, 0x11], [0x21, 0x12], [0x21, 0x13], [0x21, 0x14], [0x21, 0x15],
      [0x21, 0x16], [0x21, 0x17], [0x21, 0x18], [0x21, 0x19], [0x21, 0x1A],
      [0x21, 0x1B], [0x21, 0x1C], [0x21, 0x1D], [0x21, 0x1E], [0x21, 0x1F], [0x21, 0x20],
      // RTD Raw/Cal 1–4
      [0x22, 0x01], [0x22, 0x02], [0x22, 0x03], [0x22, 0x04],
      [0x22, 0x11], [0x22, 0x12], [0x22, 0x13], [0x22, 0x14],
      // LC Raw/Cal 1–20
      [0x23, 0x01], [0x23, 0x02], [0x23, 0x03], [0x23, 0x04], [0x23, 0x05],
      [0x23, 0x06], [0x23, 0x07], [0x23, 0x08], [0x23, 0x09], [0x23, 0x0A],
      [0x23, 0x0B], [0x23, 0x0C], [0x23, 0x0D], [0x23, 0x0E], [0x23, 0x0F], [0x23, 0x10],
      [0x23, 0x11], [0x23, 0x12], [0x23, 0x13], [0x23, 0x14], [0x23, 0x15],
      [0x23, 0x16], [0x23, 0x17], [0x23, 0x18], [0x23, 0x19], [0x23, 0x1A],
      [0x23, 0x1B], [0x23, 0x1C], [0x23, 0x1D], [0x23, 0x1E], [0x23, 0x1F], [0x23, 0x20],
      // Actuator channels (0x30, 0x01-0x0A)
      [0x30, 0x01], [0x30, 0x02], [0x30, 0x03], [0x30, 0x04], [0x30, 0x05],
      [0x30, 0x06], [0x30, 0x07], [0x30, 0x08], [0x30, 0x09], [0x30, 0x0A],
      // Actuator state (0=closed, 1=open) [0x31, 0x01-0x14]
      [0x31, 0x01], [0x31, 0x02], [0x31, 0x03], [0x31, 0x04], [0x31, 0x05],
      [0x31, 0x06], [0x31, 0x07], [0x31, 0x08], [0x31, 0x09], [0x31, 0x0A],
      [0x31, 0x0B], [0x31, 0x0C], [0x31, 0x0D], [0x31, 0x0E], [0x31, 0x0F],
      [0x31, 0x10], [0x31, 0x11], [0x31, 0x12], [0x31, 0x13], [0x31, 0x14],
      // Actuator commanded state (sequencer publishes on state transitions) [0x32, global_ch]
      // Global channel = (board_id - 11) * 10 + local_channel (up to 4 boards × 10 channels = 40)
      ...Array.from({ length: 40 }, (_, i) => [0x32, i + 1] as [number, number]),
      // Encoder Raw [0x24, 0x01-0x02]
      [0x24, 0x01], [0x24, 0x02],
      // Controller outputs (0x40=actuation, 0x41=diagnostics, 0x42=measurement)
      // PSM state transitions (0x43), fire-state events (0x44)
      // PSM actuator commands (0x50, 0x60..0x66)
      [0x40, 0x00], [0x41, 0x00], [0x42, 0x00], [0x43, 0x00], [0x44, 0x00],
      // SequencerState — published by sequencer_service
      [0x50, 0x00],
      [0x50, 0x60], [0x50, 0x61], [0x50, 0x62], [0x50, 0x63], [0x50, 0x64], [0x50, 0x65], [0x50, 0x66],
    ];

    // Subscriptions for board heartbeats [0x10, board_id (1-64)]
    for (let i = 1; i <= 64; i++) {
      subscriptions.push([0x10, i]);
    }

    // Self-test results [0x60, board_id (1-64)]
    for (let i = 1; i <= 64; i++) {
      subscriptions.push([0x60, i]);
    }

    // Try VTableStream
    const vtableStreamMsgId = computeMsgId("VTableStream");
    console.log(`   VTableStream message ID: [0x${vtableStreamMsgId[0].toString(16).padStart(2, '0')}, 0x${vtableStreamMsgId[1].toString(16).padStart(2, '0')}]`);

    let successCount = 0;
    for (const [high, low] of subscriptions) {
      // Postcard-encoded VTableStream payload: u8(high) + u8(low)
      // This matches the struct VTableStream { std::tuple<uint8_t, uint8_t> msg_id; }
      const payload = Buffer.alloc(2);
      payload.writeUInt8(high, 0);
      payload.writeUInt8(low, 1);

      // Send as MSG type (0) with VTableStream message packet_id
      const success = client.sendRawMessage(
        vtableStreamMsgId,
        ElodinPacketType.MSG,
        payload
      );

      if (success) {
        successCount++;
        // Log first few subscriptions
        if (successCount <= 5) {
          console.log(`   ✅ VTableStream subscription sent: [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
        }
      } else {
        console.error(`   ❌ Failed to send VTableStream for [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
      }
    }

    console.log(`   ✅ VTableStream: Sent ${successCount}/${subscriptions.length} subscriptions`);
    console.log('   Waiting for TABLE packets from Elodin DB...');

    return successCount > 0;
  } catch (error) {
    console.error('❌ Error during VTableStream subscription:', error);
    return false;
  }
}


/**
 * Compute FNV-1a hash for message type name (matching db.hpp msg_id function exactly)
 *
 * db.hpp implementation:
 * - fnv1a_hash_32: uses 0x811c9dc5 offset, 0x01000193 prime, limits to 32 chars
 * - fnv1a_hash_16_xor: XORs upper and lower 16 bits
 * - msg_id: returns [hash & 0xff, (hash >> 8) & 0xff]
 */
export function computeMsgId(typeName: string): [number, number] {
  // FNV-1a 32-bit hash (matching db.hpp fnv1a_hash_32)
  const FNV_OFFSET_BASIS = 0x811c9dc5;  // 2166136261 in decimal
  const FNV_PRIME = 0x01000193;         // 16777619 in decimal

  let hash = FNV_OFFSET_BASIS;
  // C++ uses `if (++i >= 32) break;` which processes at most 31 chars
  const maxLen = Math.min(typeName.length, 31);

  for (let i = 0; i < maxLen; i++) {
    hash ^= typeName.charCodeAt(i);
    // CRITICAL: Must use Math.imul for correct uint32 overflow behavior.
    // Plain `hash * FNV_PRIME` uses JS float64 and loses precision.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  // fnv1a_hash_16_xor: XOR upper and lower 16 bits
  const upper = (hash >>> 16) & 0xFFFF;
  const lower = hash & 0xFFFF;
  const xorHash = upper ^ lower;

  // msg_id: return [low_byte, high_byte]
  const lowByte = xorHash & 0xFF;
  const highByte = (xorHash >>> 8) & 0xFF;

  return [lowByte, highByte];
}
