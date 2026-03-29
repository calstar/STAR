/**
 * VTable Registration for Elodin DB
 * Registers VTables so Elodin DB knows how to stream data to us
 */

import { ElodinClient, ElodinPacketType } from '../elodin-client.js';

// Track which [high, low] pairs have already been successfully subscribed
// to avoid duplicate subscriptions on resubscribe retries (which cause
// Elodin to deliver each packet N times, inflating frequency calculations).
const subscribedPairs = new Set<string>();

/** Clear subscription tracking on disconnect so we resubscribe fresh on reconnect. */
export function clearSubscriptionState(): void {
  subscribedPairs.clear();
}

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
    // All packet IDs we want to subscribe to.
    // New packet ID scheme: low byte = (board_number - 1) * 0x20 + channel
    // for raw, + 0x10 for calibrated. board_number = board_id % 10.
    const subscriptions: Array<[number, number]> = [];

    // Helper: generate raw + cal subscriptions for a board
    const addBoard = (typeHi: number, boardNumber: number, channels: number[]) => {
      for (const ch of channels) {
        // Raw: (board_number - 1) * 0x20 + ch
        subscriptions.push([typeHi, (boardNumber - 1) * 0x20 + ch]);
        // Cal: (board_number - 1) * 0x20 + 0x10 + ch
        subscriptions.push([typeHi, (boardNumber - 1) * 0x20 + 0x10 + ch]);
      }
    };

    // PT: board 1 (channels 1-10), board 2 (channels 1-4)
    addBoard(0x20, 1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    addBoard(0x20, 2, [1, 2, 3, 4]);

    // ACT: board 2 (channels 1-10), board 4 (channels 1-10)
    addBoard(0x30, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    addBoard(0x30, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    // TC: board 1 (channels 2-5)
    addBoard(0x21, 1, [2, 3, 4, 5]);

    // RTD: board 1 (channels 1-4)
    addBoard(0x22, 1, [1, 2, 3, 4]);

    // LC: board 2 (channels 1, 2, 6)
    addBoard(0x23, 2, [1, 2, 6]);

    // ENC: board 1 (channels 1-2)
    addBoard(0x24, 1, [1, 2]);

    // ACT_CMD: boards 1-4, channels 1-10 each using (board_number-1)*0x10 + ch
    for (let bn = 1; bn <= 4; bn++) {
      for (let ch = 1; ch <= 10; ch++) {
        subscriptions.push([0x32, (bn - 1) * 0x20 + ch]);
      }
    }

    // Controller outputs (0x40=actuation, 0x41=diagnostics, 0x42=measurement)
    // PSM state transitions (0x43), fire-state events (0x44)
    // PSM actuator commands (0x50, 0x60..0x66)
    subscriptions.push(
      [0x40, 0x00], [0x41, 0x00], [0x42, 0x00], [0x43, 0x00], [0x44, 0x00],
      // SequencerState — published by sequencer_service
      [0x50, 0x00],
      [0x50, 0x60], [0x50, 0x61], [0x50, 0x62], [0x50, 0x63], [0x50, 0x64], [0x50, 0x65], [0x50, 0x66],
    );

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

    // Calibrated VTable subscriptions (low byte >= 0x10) may have been sent
    // before calibration_service registered them with Elodin. Elodin silently
    // drops subscriptions for unregistered VTables. Clear these on each retry
    // so they get re-sent until they actually stick.
    // Calibrated subscriptions have bit pattern: block_offset 0x10-0x1F within 32-slot block
    for (const key of [...subscribedPairs]) {
      const [, lowStr] = key.split(',');
      const low = parseInt(lowStr, 10);
      const blockOffset = low & 0x1F;
      if (blockOffset >= 0x10) {
        subscribedPairs.delete(key);
      }
    }

    let successCount = 0;
    let skippedCount = 0;
    for (const [high, low] of subscriptions) {
      const key = `${high},${low}`;
      if (subscribedPairs.has(key)) {
        skippedCount++;
        continue;
      }

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
        subscribedPairs.add(key);
        successCount++;
        // Log first few subscriptions
        if (successCount <= 5) {
          console.log(`   ✅ VTableStream subscription sent: [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
        }
      } else {
        console.error(`   ❌ Failed to send VTableStream for [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
      }
    }

    console.log(`   ✅ VTableStream: Sent ${successCount} new, skipped ${skippedCount} already subscribed (${subscriptions.length} total)`);
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
