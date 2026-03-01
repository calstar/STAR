/**
 * @file elodin-vtable-controller.ts
 * @brief Register VTables for controller messages in Elodin DB
 *
 * Registers VTables for:
 * - ControllerActuationMessage (packet ID [0x40, 0x00])
 * - ControllerDiagnosticsMessage (packet ID [0x41, 0x00])
 * - ControllerMeasurementMessage (packet ID [0x42, 0x00])
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';
import { computeMsgId } from './elodin-vtable.js';

/**
 * Register controller VTables with Elodin DB
 * Uses postcard encoding to send VTableMsg messages
 */
export async function registerControllerVTables(client: ElodinClient): Promise<boolean> {
  if (!client.isConnected()) {
    console.warn('⚠️ Cannot register controller VTables - Elodin client not connected');
    return false;
  }

  console.log('📡 Registering controller VTables with Elodin DB...');

  try {
    // VTableMsg message ID
    const vtableMsgId = computeMsgId("VTableMsg");
    console.log(`   VTableMsg message ID: [0x${vtableMsgId[0].toString(16).padStart(2, '0')}, 0x${vtableMsgId[1].toString(16).padStart(2, '0')}]`);

    // ControllerActuationMessage VTable
    // Fields: timestamp_ns (u64), duty_F (f32), duty_O (f32), u_F_on (u8), u_O_on (u8), valid (u8)
    // Total: 8 + 4 + 4 + 1 + 1 + 1 = 19 bytes
    const actuationVTable = encodeVTable({
      packetId: [0x40, 0x00],
      fields: [
        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.actuation.timestamp_ns' },
        { offset: 8, size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_F' },
        { offset: 12, size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_O' },
        { offset: 16, size: 1, type: 'u8', component: 'CONTROLLER.actuation.u_F_on' },
        { offset: 17, size: 1, type: 'u8', component: 'CONTROLLER.actuation.u_O_on' },
        { offset: 18, size: 1, type: 'u8', component: 'CONTROLLER.actuation.valid' },
      ],
    });

    // ControllerDiagnosticsMessage VTable
    // Fields: timestamp_ns (u64), F_ref (f64), MR_ref (f64), F_estimated (f64), MR_estimated (f64),
    //         P_ch (f64), cost (f64), safety_filtered (u8), cutoff_active (u8), solver_iters (i32)
    // Total: 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1 + 1 + 4 = 62 bytes
    const diagnosticsVTable = encodeVTable({
      packetId: [0x41, 0x00],
      fields: [
        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.diagnostics.timestamp_ns' },
        { offset: 8, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.F_ref' },
        { offset: 16, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.MR_ref' },
        { offset: 24, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.F_estimated' },
        { offset: 32, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.MR_estimated' },
        { offset: 40, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.P_ch' },
        { offset: 48, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.cost' },
        { offset: 56, size: 1, type: 'u8', component: 'CONTROLLER.diagnostics.safety_filtered' },
        { offset: 57, size: 1, type: 'u8', component: 'CONTROLLER.diagnostics.cutoff_active' },
        { offset: 58, size: 4, type: 'i32', component: 'CONTROLLER.diagnostics.solver_iters' },
      ],
    });

    // ControllerMeasurementMessage VTable
    // Fields: timestamp_ns (u64), P_copv (f64), P_reg (f64), P_u_fuel (f64), P_u_ox (f64),
    //         P_d_fuel (f64), P_d_ox (f64)
    // Total: 8 + 8 + 8 + 8 + 8 + 8 + 8 = 56 bytes
    const measurementVTable = encodeVTable({
      packetId: [0x42, 0x00],
      fields: [
        { offset: 0, size: 8, type: 'u64', component: 'CONTROLLER.measurement.timestamp_ns' },
        { offset: 8, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_copv' },
        { offset: 16, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_reg' },
        { offset: 24, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_fuel' },
        { offset: 32, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_ox' },
        { offset: 40, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_fuel' },
        { offset: 48, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_ox' },
      ],
    });

    // Send VTable registration messages
    const vtables = [
      { name: 'ControllerActuation', vtable: actuationVTable, packetId: [0x40, 0x00] },
      { name: 'ControllerDiagnostics', vtable: diagnosticsVTable, packetId: [0x41, 0x00] },
      { name: 'ControllerMeasurement', vtable: measurementVTable, packetId: [0x42, 0x00] },
    ];

    let successCount = 0;
    for (const { name, vtable, packetId } of vtables) {
      // Send VTableMsg (postcard-encoded)
      const success = client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtable);
      if (success) {
        successCount++;
        console.log(`   ✅ Registered ${name} VTable (packetId=[0x${packetId[0].toString(16).padStart(2, '0')}, 0x${packetId[1].toString(16).padStart(2, '0')}])`);
      } else {
        console.error(`   ❌ Failed to register ${name} VTable`);
      }
    }

    console.log(`   ✅ Registered ${successCount}/${vtables.length} controller VTables`);
    return successCount > 0;
  } catch (error) {
    console.error('❌ Error registering controller VTables:', error);
    return false;
  }
}

/**
 * Encode a VTable structure for Elodin DB
 * This is a simplified version - full implementation would use postcard encoding
 */
function encodeVTable(config: {
  packetId: [number, number];
  fields: Array<{ offset: number; size: number; type: string; component: string }>;
}): Buffer {
  // Simplified VTable encoding
  // Full implementation would use postcard encoding with OpBuilder, FieldBuilder, etc.
  // For now, we'll create a minimal structure that Elodin can understand

  // VTable structure (simplified):
  // - packet_id (2 bytes)
  // - field count (1 byte)
  // - For each field: offset (4 bytes), size (4 bytes), type (1 byte), component_name (string)

  const buffer = Buffer.alloc(1024); // Allocate enough space
  let offset = 0;

  // Write packet_id
  buffer.writeUInt8(config.packetId[0], offset++);
  buffer.writeUInt8(config.packetId[1], offset++);

  // Write field count
  buffer.writeUInt8(config.fields.length, offset++);

  // Write each field
  for (const field of config.fields) {
    buffer.writeUInt32LE(field.offset, offset);
    offset += 4;
    buffer.writeUInt32LE(field.size, offset);
    offset += 4;

    // Type encoding: u64=0, f64=1, f32=2, u32=3, i32=4, u8=5
    const typeMap: Record<string, number> = {
      'u64': 0, 'f64': 1, 'f32': 2, 'u32': 3, 'i32': 4, 'u8': 5,
    };
    buffer.writeUInt8(typeMap[field.type] || 0, offset++);

    // Component name (length-prefixed string)
    const componentBytes = Buffer.from(field.component, 'utf-8');
    buffer.writeUInt8(componentBytes.length, offset++);
    componentBytes.copy(buffer, offset);
    offset += componentBytes.length;
  }

  return buffer.subarray(0, offset);
}
