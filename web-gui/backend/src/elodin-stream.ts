/**
 * Stream subscription using Stream message with StreamFilter
 * This might be the correct way to subscribe to Elodin DB data streams
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';
// Import computeMsgId - it's exported from elodin-vtable.ts
import { computeMsgId } from './elodin-vtable.js';

/**
 * Subscribe using Stream message with StreamFilter
 * StreamFilter can filter by component_id or entity_id (both optional)
 * If both are None, it should stream all data
 */
export async function subscribeWithStream(client: ElodinClient): Promise<boolean> {
  if (!client.isConnected()) {
    console.warn('⚠️ Cannot subscribe - Elodin client not connected');
    return false;
  }

  console.log('📡 Trying Stream message subscription...');
  console.log('   StreamFilter with no filters should stream all data');

  try {
    // Stream message ID
    const streamMsgId = computeMsgId("Stream");
    console.log(`   Stream message ID: [0x${streamMsgId[0].toString(16).padStart(2, '0')}, 0x${streamMsgId[1].toString(16).padStart(2, '0')}]`);

    // Stream struct:
    //   StreamFilter filter;  // component_id: Option<u64>, entity_id: Option<u64>
    //   StreamBehavior behavior;  // RealTime or FixedRate
    //   u64 id;
    //
    // StreamFilter encoding (both optional):
    //   Option<u64> component_id: 0x00 (None) or 0x01 (Some) + u64
    //   Option<u64> entity_id: 0x00 (None) or 0x01 (Some) + u64
    //
    // StreamBehavior encoding:
    //   Variant: 0x00 = RealTime (monostate), 0x01 = FixedRate(u32)
    //
    // For now, try empty filter (both None) + RealTime behavior + id=0

    // StreamFilter: both None
    // Option encoding: 0x00 = None
    const filterBytes = Buffer.from([0x00, 0x00]); // component_id=None, entity_id=None

    // StreamBehavior: RealTime (variant index 0, monostate)
    // Variant encoding: u8 discriminant (0 for RealTime)
    const behaviorBytes = Buffer.from([0x00]); // RealTime

    // Stream id: u64 = 0
    const idBytes = Buffer.alloc(8);
    idBytes.writeBigUInt64LE(BigInt(0), 0);

    // Combine: filter + behavior + id
    const payload = Buffer.concat([filterBytes, behaviorBytes, idBytes]);

    console.log(`   Payload length: ${payload.length} bytes`);
    console.log(`   Payload (hex): ${payload.toString('hex')}`);

    const success = client.sendRawMessage(
      streamMsgId,
      ElodinPacketType.MSG,
      payload
    );

    if (success) {
      console.log('   ✅ Stream subscription sent');
      return true;
    } else {
      console.error('   ❌ Failed to send Stream subscription');
      return false;
    }
  } catch (error) {
    console.error('❌ Error during Stream subscription:', error);
    return false;
  }
}
