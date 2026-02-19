/**
 * VTable Registration for Elodin DB
 * Registers VTables so Elodin DB knows how to stream data to us
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';

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

  console.log('📡 Trying MsgStream subscriptions (alternative to VTableStream)...');
  console.log('   MsgStream has same structure as VTableStream: std::tuple<uint8_t, uint8_t> msg_id');
  console.log('');

  try {
    // All packet IDs we want to subscribe to
    const subscriptions: Array<[number, number]> = [
      // PT Raw channels (0x20, 0x01-0x0A)
      [0x20, 0x01], [0x20, 0x02], [0x20, 0x03], [0x20, 0x04], [0x20, 0x05],
      [0x20, 0x06], [0x20, 0x07], [0x20, 0x08], [0x20, 0x09], [0x20, 0x0A],
      // PT Calibrated channels (0x20, 0x11-0x1A)
      [0x20, 0x11], [0x20, 0x12], [0x20, 0x13], [0x20, 0x14], [0x20, 0x15],
      [0x20, 0x16], [0x20, 0x17], [0x20, 0x18], [0x20, 0x19], [0x20, 0x1A],
      // TC Raw channels (0x21, 0x01-0x04)
      [0x21, 0x01], [0x21, 0x02], [0x21, 0x03], [0x21, 0x04],
      // TC Calibrated channels (0x21, 0x11-0x14)
      [0x21, 0x11], [0x21, 0x12], [0x21, 0x13], [0x21, 0x14],
      // RTD Raw channels (0x22, 0x01-0x04)
      [0x22, 0x01], [0x22, 0x02], [0x22, 0x03], [0x22, 0x04],
      // RTD Calibrated channels (0x22, 0x11-0x14)
      [0x22, 0x11], [0x22, 0x12], [0x22, 0x13], [0x22, 0x14],
      // Actuator channels (0x30, 0x01-0x0A)
      [0x30, 0x01], [0x30, 0x02], [0x30, 0x03], [0x30, 0x04], [0x30, 0x05],
      [0x30, 0x06], [0x30, 0x07], [0x30, 0x08], [0x30, 0x09], [0x30, 0x0A],
    ];

    // Try MsgStream instead of VTableStream
    const msgStreamMsgId = computeMsgId("MsgStream");
    console.log(`   MsgStream message ID: [0x${msgStreamMsgId[0].toString(16).padStart(2, '0')}, 0x${msgStreamMsgId[1].toString(16).padStart(2, '0')}]`);

    let successCount = 0;
    for (const [high, low] of subscriptions) {
      // Postcard-encoded MsgStream payload: u8(high) + u8(low)
      // This matches the struct MsgStream { std::tuple<uint8_t, uint8_t> msg_id; }
      const payload = Buffer.alloc(2);
      payload.writeUInt8(high, 0);
      payload.writeUInt8(low, 1);

      // Send as MSG type (0) with MsgStream message packet_id
      const success = client.sendRawMessage(
        msgStreamMsgId,
        ElodinPacketType.MSG,
        payload
      );

      if (success) {
        successCount++;
        // Log first few subscriptions
        if (successCount <= 5) {
          console.log(`   ✅ MsgStream subscription sent: [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
        }
      } else {
        console.error(`   ❌ Failed to send MsgStream for [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}]`);
      }
    }

    console.log(`   ✅ MsgStream: Sent ${successCount}/${subscriptions.length} subscriptions`);
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
  const maxLen = Math.min(typeName.length, 32);  // Limit to 32 chars like db.hpp

  for (let i = 0; i < maxLen; i++) {
    hash ^= typeName.charCodeAt(i);
    hash = (hash * FNV_PRIME) >>> 0;  // Force unsigned 32-bit
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
