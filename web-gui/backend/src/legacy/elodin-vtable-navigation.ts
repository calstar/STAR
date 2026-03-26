/**
 * @file elodin-vtable-navigation.ts
 * @brief Register NavigationMessage VTable for autopilot/navigation
 *
 * Packet ID [0x45, 0x00] — matches daq_comms FlightMessages.hpp NavigationMessage:
 *   U64 timestamp_ns + 13×F64 (pos_ned, vel_ned, quat, acc_ned) = 112 bytes
 *
 * Autopilot/navigation writes to Elodin using:
 *   elodin.publish([0x45, 0x00], payload)
 */

import { ElodinClient, ElodinPacketType } from '../elodin-client.js';
import { computeMsgId } from './elodin-vtable.js';

export async function registerNavigationVTable(client: ElodinClient): Promise<boolean> {
  if (!client.isConnected()) return false;

  try {
    const vtableMsgId = computeMsgId("VTableMsg");
    const navVTable = encodeVTable({
      packetId: [0x45, 0x00],
      fields: [
        { offset: 0,  size: 8, type: 'u64', component: 'NAV.timestamp_ns' },
        { offset: 8,  size: 8, type: 'f64', component: 'NAV.position_ned_x' },
        { offset: 16, size: 8, type: 'f64', component: 'NAV.position_ned_y' },
        { offset: 24, size: 8, type: 'f64', component: 'NAV.position_ned_z' },
        { offset: 32, size: 8, type: 'f64', component: 'NAV.velocity_ned_x' },
        { offset: 40, size: 8, type: 'f64', component: 'NAV.velocity_ned_y' },
        { offset: 48, size: 8, type: 'f64', component: 'NAV.velocity_ned_z' },
        { offset: 56, size: 8, type: 'f64', component: 'NAV.quaternion_w' },
        { offset: 64, size: 8, type: 'f64', component: 'NAV.quaternion_x' },
        { offset: 72, size: 8, type: 'f64', component: 'NAV.quaternion_y' },
        { offset: 80, size: 8, type: 'f64', component: 'NAV.quaternion_z' },
        { offset: 88, size: 8, type: 'f64', component: 'NAV.acceleration_ned_x' },
        { offset: 96, size: 8, type: 'f64', component: 'NAV.acceleration_ned_y' },
        { offset: 104, size: 8, type: 'f64', component: 'NAV.acceleration_ned_z' },
      ],
    });

    const success = client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, navVTable);
    if (success) {
      console.log('   ✅ Registered NavigationMessage VTable ([0x45, 0x00])');
    }
    return success;
  } catch (error) {
    console.error('❌ Error registering Navigation VTable:', error);
    return false;
  }
}

function encodeVTable(config: {
  packetId: [number, number];
  fields: Array<{ offset: number; size: number; type: string; component: string }>;
}): Buffer {
  const buffer = Buffer.alloc(512);
  let offset = 0;
  buffer.writeUInt8(config.packetId[0], offset++);
  buffer.writeUInt8(config.packetId[1], offset++);
  buffer.writeUInt8(config.fields.length, offset++);
  const typeMap: Record<string, number> = {
    u64: 0, f64: 1, f32: 2, u32: 3, i32: 4, u8: 5,
  };
  for (const field of config.fields) {
    buffer.writeUInt32LE(field.offset, offset); offset += 4;
    buffer.writeUInt32LE(field.size, offset); offset += 4;
    buffer.writeUInt8(typeMap[field.type] ?? 0, offset++);
    const componentBytes = Buffer.from(field.component, 'utf-8');
    buffer.writeUInt8(componentBytes.length, offset++);
    componentBytes.copy(buffer, offset);
    offset += componentBytes.length;
  }
  return buffer.subarray(0, offset);
}
