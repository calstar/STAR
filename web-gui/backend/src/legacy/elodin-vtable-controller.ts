/**
 * @file elodin-vtable-controller.ts
 * @brief Register VTables for controller messages in Elodin DB
 *
 * Registers VTables for:
 * - ControllerActuationMessage     [0x40, 0x00]  19 bytes
 * - ControllerDiagnosticsMessage   [0x41, 0x00]  62 bytes
 * - ControllerMeasurementMessage   [0x42, 0x00]  80 bytes (+ P_ch_mp1/P_ch_mp2)
 * - ControllerStateTransitionMsg   [0x43, 0x00]  11 bytes
 * - ControllerFireStateMessage     [0x44, 0x00]  17 bytes
 */

import { ElodinClient, ElodinPacketType } from '../elodin-client.js';
import { computeMsgId } from '../elodin-vtable-registry.js';

export async function registerControllerVTables(client: ElodinClient): Promise<boolean> {
  if (!client.isConnected()) {
    console.warn('⚠️ Cannot register controller VTables - Elodin client not connected');
    return false;
  }

  console.log('📡 Registering controller VTables with Elodin DB...');

  try {
    const vtableMsgId = computeMsgId("VTableMsg");

    // [0x40, 0x00] Actuation: U64+F32+F32+U8+U8+U8 = 19 bytes
    const actuationVTable = encodeVTable({
      packetId: [0x40, 0x00],
      fields: [
        { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.actuation.timestamp_ns' },
        { offset: 8,  size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_F' },
        { offset: 12, size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_O' },
        { offset: 16, size: 1, type: 'u8',  component: 'CONTROLLER.actuation.u_F_on' },
        { offset: 17, size: 1, type: 'u8',  component: 'CONTROLLER.actuation.u_O_on' },
        { offset: 18, size: 1, type: 'u8',  component: 'CONTROLLER.actuation.valid' },
      ],
    });

    // [0x41, 0x00] Diagnostics: U64+6×F64+I32(56)+U8(60)+U8(61) = 62 bytes
    const diagnosticsVTable = encodeVTable({
      packetId: [0x41, 0x00],
      fields: [
        { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.diagnostics.timestamp_ns' },
        { offset: 8,  size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.F_ref' },
        { offset: 16, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.MR_ref' },
        { offset: 24, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.F_estimated' },
        { offset: 32, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.MR_estimated' },
        { offset: 40, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.P_ch' },
        { offset: 48, size: 8, type: 'f64', component: 'CONTROLLER.diagnostics.cost' },
        { offset: 56, size: 4, type: 'i32', component: 'CONTROLLER.diagnostics.solver_iters' },
        { offset: 60, size: 1, type: 'u8',  component: 'CONTROLLER.diagnostics.safety_filtered' },
        { offset: 61, size: 1, type: 'u8',  component: 'CONTROLLER.diagnostics.cutoff_active' },
      ],
    });

    // [0x42, 0x00] Measurement: U64+8×F64 = 80 bytes (P_ch_mp1 at 56, P_ch_mp2 at 64)
    const measurementVTable = encodeVTable({
      packetId: [0x42, 0x00],
      fields: [
        { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.measurement.timestamp_ns' },
        { offset: 8,  size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_copv' },
        { offset: 16, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_reg' },
        { offset: 24, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_fuel' },
        { offset: 32, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_ox' },
        { offset: 40, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_fuel' },
        { offset: 48, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_ox' },
        { offset: 56, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_ch_mp1' },
        { offset: 64, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_ch_mp2' },
      ],
    });

    // [0x43, 0x00] PSM State Transition: U64+U8+U8+U8 = 11 bytes
    const stateTransVTable = encodeVTable({
      packetId: [0x43, 0x00],
      fields: [
        { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.state.timestamp_ns' },
        { offset: 8,  size: 1, type: 'u8',  component: 'CONTROLLER.state.from_state' },
        { offset: 9,  size: 1, type: 'u8',  component: 'CONTROLLER.state.to_state' },
        { offset: 10, size: 1, type: 'u8',  component: 'CONTROLLER.state.reason' },
      ],
    });

    // [0x44, 0x00] Fire State Event: U64+U8+F32+F32 = 17 bytes
    const fireStateVTable = encodeVTable({
      packetId: [0x44, 0x00],
      fields: [
        { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.fire.timestamp_ns' },
        { offset: 8,  size: 1, type: 'u8',  component: 'CONTROLLER.fire.fire_active' },
        { offset: 9,  size: 4, type: 'f32', component: 'CONTROLLER.fire.duty_F' },
        { offset: 13, size: 4, type: 'f32', component: 'CONTROLLER.fire.duty_O' },
      ],
    });

    const vtables = [
      { name: 'ControllerActuation',      vtable: actuationVTable,    packetId: [0x40, 0x00] },
      { name: 'ControllerDiagnostics',    vtable: diagnosticsVTable,  packetId: [0x41, 0x00] },
      { name: 'ControllerMeasurement',    vtable: measurementVTable,  packetId: [0x42, 0x00] },
      { name: 'ControllerStateTransition',vtable: stateTransVTable,   packetId: [0x43, 0x00] },
      { name: 'ControllerFireState',      vtable: fireStateVTable,    packetId: [0x44, 0x00] },
    ];

    let successCount = 0;
    for (const { name, vtable, packetId } of vtables) {
      const success = client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vtable);
      if (success) {
        successCount++;
        console.log(`   ✅ Registered ${name} VTable ([0x${packetId[0].toString(16).padStart(2,'0')}, 0x${packetId[1].toString(16).padStart(2,'0')}])`);
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
 * Register VTables for commanded actuator state [0x32, ch].
 * Separate from [0x31] (current-sense/hardware) so postprocessing uses commanded state.
 */
export async function registerActuatorCommandedVTables(
  client: ElodinClient,
  actuatorChannelToEntityMap: Record<number, string>
): Promise<boolean> {
  if (!client.isConnected()) return false;
  const vtableMsgId = computeMsgId("VTableMsg");
  let count = 0;
  for (let ch = 1; ch <= 20; ch++) {
    const entity = actuatorChannelToEntityMap[ch] || `ACT.CH${ch}`;
    const component = `${entity}.actuator_state_commanded`;
    const vt = encodeVTable({
      packetId: [0x32, ch],
      fields: [
        { offset: 0, size: 8, type: 'u64', component: `${entity}.timestamp_ns` },
        { offset: 8, size: 1, type: 'u8', component: `${entity}.channel_id` },
        { offset: 9, size: 1, type: 'u8', component },
      ],
    });
    if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vt)) {
      count++;
    }
  }
  if (count > 0) {
    console.log(`   ✅ Registered ${count} actuator commanded VTables [0x32, 0x01-0x14]`);
  }
  return count > 0;
}

function encodeVTable(config: {
  packetId: [number, number];
  fields: Array<{ offset: number; size: number; type: string; component: string }>;
}): Buffer {
  const buffer = Buffer.alloc(1024);
  let offset = 0;

  buffer.writeUInt8(config.packetId[0], offset++);
  buffer.writeUInt8(config.packetId[1], offset++);
  buffer.writeUInt8(config.fields.length, offset++);

  for (const field of config.fields) {
    buffer.writeUInt32LE(field.offset, offset); offset += 4;
    buffer.writeUInt32LE(field.size,   offset); offset += 4;
    const typeMap: Record<string, number> = {
      u64: 0, f64: 1, f32: 2, u32: 3, i32: 4, u8: 5,
    };
    buffer.writeUInt8(typeMap[field.type] ?? 0, offset++);
    const componentBytes = Buffer.from(field.component, 'utf-8');
    buffer.writeUInt8(componentBytes.length, offset++);
    componentBytes.copy(buffer, offset);
    offset += componentBytes.length;
  }

  return buffer.subarray(0, offset);
}
