/**
 * Elodin VTable Registration
 * Registers VTables with Elodin DB so it streams data to us
 * Based on DatabaseConfig.cpp
 *
 * We use VTableStream messages to subscribe to data streams.
 * This is simpler than full VTable registration.
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';

/**
 * Compute FNV-1a hash for message type name (matching db.hpp msg_id function)
 * Returns [low_byte, high_byte] as packet_id
 *
 * From db.hpp:
 * - fnv1a_hash_32: FNV-1a 32-bit hash
 * - fnv1a_hash_16_xor: XOR upper and lower 16 bits
 * - msg_id: Extract [low_byte, high_byte] from 16-bit XOR result
 */
function computeMsgId(typeName: string): [number, number] {
  // FNV-1a 32-bit hash (matching db.hpp fnv1a_hash_32)
  const FNV_OFFSET_BASIS = 2166136261; // 0x811C9DC5
  const FNV_PRIME = 16777619; // 0x01000193

  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < typeName.length; i++) {
    hash ^= typeName.charCodeAt(i);
    hash = (hash * FNV_PRIME) >>> 0; // Force unsigned 32-bit multiplication
  }

  // XOR upper and lower 16 bits (fnv1a_hash_16_xor)
  const upper = (hash >>> 16) & 0xFFFF;
  const lower = hash & 0xFFFF;
  const xorHash = upper ^ lower;

  // Extract bytes: [low_byte, high_byte] (matching db.hpp msg_id)
  // Note: db.hpp returns {low_byte, high_byte} where:
  //   low_byte = hash & 0xff
  //   high_byte = (hash >> 8) & 0xff
  const lowByte = xorHash & 0xFF;
  const highByte = (xorHash >>> 8) & 0xFF;

  return [lowByte, highByte];
}

/**
 * Register VTables with Elodin DB using VTableStream messages
 * This tells Elodin DB to stream data for specific packet IDs
 */
export async function registerVTables(client: ElodinClient): Promise<boolean> {
  console.log('📋 Registering VTableStream subscriptions with Elodin DB...');
  console.log('   This tells Elodin DB to stream data to this client');

  if (!client.connected) {
    console.error('❌ Cannot register VTables - not connected to Elodin DB');
    return false;
  }

  try {
    // Subscribe to PT Calibrated channels (0x20, 0x11-0x1A)
    // VTableStream message format: [packet_id_high, packet_id_low] encoded as postcard
    // But we can try sending a simple message first

    const subscriptions: Array<[number, number]> = [
      // PT Calibrated channels
      [0x20, 0x11], [0x20, 0x12], [0x20, 0x13], [0x20, 0x14], [0x20, 0x15],
      [0x20, 0x16], [0x20, 0x17], [0x20, 0x18], [0x20, 0x19], [0x20, 0x1A],
      // PT Raw channels (0x20, 0x01-0x0A)
      [0x20, 0x01], [0x20, 0x02], [0x20, 0x03], [0x20, 0x04], [0x20, 0x05],
      [0x20, 0x06], [0x20, 0x07], [0x20, 0x08], [0x20, 0x09], [0x20, 0x0A],
      // Actuator channels (0x30, 0x01-0x0A)
      [0x30, 0x01], [0x30, 0x02], [0x30, 0x03], [0x30, 0x04], [0x30, 0x05],
      [0x30, 0x06], [0x30, 0x07], [0x30, 0x08], [0x30, 0x09], [0x30, 0x0A],
    ];

    // Based on db.hpp analysis:
    // - VTableStream is a message type with packet_id = hash("VTableStream")
    // - The payload is postcard-encoded: u8(high) + u8(low)
    // - It's wrapped in a Msg packet with type MSG (0)
    //
    // Compute the correct packet_id for "VTableStream" message
    const vtableStreamMsgId = computeMsgId("VTableStream");
    console.log(`   📋 VTableStream message ID: [0x${vtableStreamMsgId[0].toString(16).padStart(2, '0')}, 0x${vtableStreamMsgId[1].toString(16).padStart(2, '0')}]`);

    let successCount = 0;
    for (const [high, low] of subscriptions) {
      // Postcard-encoded VTableStream payload: u8(high) + u8(low)
      const payload = Buffer.alloc(2);
      payload.writeUInt8(high, 0);
      payload.writeUInt8(low, 1);

      // Send as MSG type (0) with correct VTableStream message packet_id
      const success = client.sendRawMessage(
        vtableStreamMsgId,  // Packet ID for "VTableStream" message type (computed hash)
        ElodinPacketType.MSG,  // MSG type for protocol messages
        payload  // Postcard-encoded VTableStream { id: (high, low) }
      );

      if (success) {
        successCount++;
        // Don't log every single subscription - too verbose
        if (successCount <= 5 || successCount % 10 === 0) {
          console.log(`   ✅ Sent VTableStream for [0x${high.toString(16).padStart(2, '0')}, 0x${low.toString(16).padStart(2, '0')}] (${successCount}/${subscriptions.length})`);
        }
      }
    }

    if (successCount === subscriptions.length) {
      console.log(`   ✅ All ${subscriptions.length} subscriptions sent successfully`);
    } else {
      console.warn(`   ⚠️ Only ${successCount}/${subscriptions.length} subscriptions sent`);
    }

    console.log(`✅ VTableStream registration complete: ${successCount}/${subscriptions.length} subscriptions sent`);
    console.log('   ⚠️ If still no data, Elodin DB may require FULL VTable registration (like DAQ Bridge)');
    console.log('   ⚠️ Full VTable registration requires postcard-encoding VTableMsg with field definitions');
    console.log('   ⚠️ This is complex - checking if VTableStream subscriptions work first...');
    return successCount > 0;
  } catch (error) {
    console.error('❌ Failed to register VTables:', error);
    return false;
  }
}
