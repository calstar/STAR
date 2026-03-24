/**
 * VTable Registration for Elodin DB
 *
 * Registers VTables (schema definitions) and VTableStream subscriptions so
 * Elodin DB streams TABLE packets for the requested packet IDs.
 *
 * DAQ Bridge registers sensor VTables on its side; this module subscribes
 * to those streams and also registers controller + actuator-commanded VTables
 * that the relay/backend publishes.
 */

import { ElodinClient, ElodinPacketType } from './elodin-client.js';

// ── Subscription list ──────────────────────────────────────────────────

const SENSOR_SUBSCRIPTIONS: Array<[number, number]> = [
  // PT Raw (board 1: 0x01-0x0A, board 2: 0x0B-0x0E)
  ...[1,2,3,4,5,6,7,8,9,10,11,12,13,14].map(ch => [0x20, ch] as [number, number]),
  // PT Calibrated (0x11-0x1E)
  ...[0x11,0x12,0x13,0x14,0x15,0x16,0x17,0x18,0x19,0x1A,0x1B,0x1C,0x1D,0x1E].map(ch => [0x20, ch] as [number, number]),
  // TC Raw+Cal (0x01-0x10, 0x11-0x20)
  ...[...Array(32)].map((_, i) => [0x21, i + 1] as [number, number]),
  // RTD Raw+Cal (0x01-0x04, 0x11-0x14)
  [0x22,0x01],[0x22,0x02],[0x22,0x03],[0x22,0x04],
  [0x22,0x11],[0x22,0x12],[0x22,0x13],[0x22,0x14],
  // LC Raw+Cal (0x01-0x10, 0x11-0x20)
  ...[...Array(32)].map((_, i) => [0x23, i + 1] as [number, number]),
  // Actuator channels (0x30, 0x01-0x0A)
  ...[1,2,3,4,5,6,7,8,9,10].map(ch => [0x30, ch] as [number, number]),
  // Actuator state (0x31, 0x01-0x14)
  ...[...Array(20)].map((_, i) => [0x31, i + 1] as [number, number]),
  // Controller outputs + PSM
  [0x40,0x00],[0x41,0x00],[0x42,0x00],[0x43,0x00],[0x44,0x00],
  // SequencerState [0x50, 0x00] — published by sequencer_service
  [0x50,0x00],
  // PSM Actuator Commands [0x50, 0x60-0x66]
  [0x50,0x60],[0x50,0x61],[0x50,0x62],[0x50,0x63],[0x50,0x64],[0x50,0x65],[0x50,0x66],
];

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Send VTableStream subscriptions for all sensor/actuator/controller packet IDs,
 * plus board heartbeats [0x10, 1-64].
 */
export async function registerVTables(client: ElodinClient): Promise<boolean> {
  if (!client.isConnected()) return false;

  const subscriptions: Array<[number, number]> = [
    ...SENSOR_SUBSCRIPTIONS,
    // Board heartbeats [0x10, board_id (1-64)]
    ...[...Array(64)].map((_, i) => [0x10, i + 1] as [number, number]),
  ];

  const vtableStreamMsgId = computeMsgId('VTableStream');
  let ok = 0;
  for (const [high, low] of subscriptions) {
    const payload = Buffer.alloc(2);
    payload.writeUInt8(high, 0);
    payload.writeUInt8(low, 1);
    if (client.sendRawMessage(vtableStreamMsgId, ElodinPacketType.MSG, payload)) ok++;
  }

  console.log(`[VTable] VTableStream subscriptions: ${ok}/${subscriptions.length} sent`);
  return ok > 0;
}

/**
 * Register controller VTables (0x40-0x44) so Elodin accepts TABLE publishes.
 */
export async function registerControllerVTables(client: ElodinClient): Promise<boolean> {
  if (!client.isConnected()) return false;

  const vtableMsgId = computeMsgId('VTableMsg');

  const vtables: Array<{ name: string; buf: Buffer }> = [
    // [0x40] Actuation: U64+F32+F32+U8+U8+U8 = 19 bytes
    { name: 'Actuation', buf: encodeVTable([0x40, 0x00], [
      { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.actuation.timestamp_ns' },
      { offset: 8,  size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_F' },
      { offset: 12, size: 4, type: 'f32', component: 'CONTROLLER.actuation.duty_O' },
      { offset: 16, size: 1, type: 'u8',  component: 'CONTROLLER.actuation.u_F_on' },
      { offset: 17, size: 1, type: 'u8',  component: 'CONTROLLER.actuation.u_O_on' },
      { offset: 18, size: 1, type: 'u8',  component: 'CONTROLLER.actuation.valid' },
    ])},
    // [0x41] Diagnostics: U64+6×F64+I32+U8+U8 = 62 bytes
    { name: 'Diagnostics', buf: encodeVTable([0x41, 0x00], [
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
    ])},
    // [0x42] Measurement: U64+8×F64 = 72 bytes
    { name: 'Measurement', buf: encodeVTable([0x42, 0x00], [
      { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.measurement.timestamp_ns' },
      { offset: 8,  size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_copv' },
      { offset: 16, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_reg' },
      { offset: 24, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_fuel' },
      { offset: 32, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_u_ox' },
      { offset: 40, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_fuel' },
      { offset: 48, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_d_ox' },
      { offset: 56, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_ch_mp1' },
      { offset: 64, size: 8, type: 'f64', component: 'CONTROLLER.measurement.P_ch_mp2' },
    ])},
    // [0x44] Fire State: U64+U8+F32+F32 = 17 bytes
    { name: 'FireState', buf: encodeVTable([0x44, 0x00], [
      { offset: 0,  size: 8, type: 'u64', component: 'CONTROLLER.fire.timestamp_ns' },
      { offset: 8,  size: 1, type: 'u8',  component: 'CONTROLLER.fire.fire_active' },
      { offset: 9,  size: 4, type: 'f32', component: 'CONTROLLER.fire.duty_F' },
      { offset: 13, size: 4, type: 'f32', component: 'CONTROLLER.fire.duty_O' },
    ])}
  ];

  let ok = 0;
  for (const { buf } of vtables) {
    if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, buf)) ok++;
  }
  console.log(`[VTable] Controller VTables: ${ok}/${vtables.length} registered`);
  return ok > 0;
}

/**
 * Register VTables for commanded actuator state [0x32, ch].
 * Separate from [0x31] (current-sense/hardware) so postprocessing uses commanded state.
 */
export async function registerActuatorCommandedVTables(
  client: ElodinClient,
  actuatorChannelToEntityMap: Record<number, string>,
): Promise<boolean> {
  if (!client.isConnected()) return false;
  const vtableMsgId = computeMsgId('VTableMsg');
  let ok = 0;
  for (let ch = 1; ch <= 20; ch++) {
    const entity = actuatorChannelToEntityMap[ch] || `ACT.CH${ch}`;
    const vt = encodeVTable([0x32, ch], [
      { offset: 0, size: 8, type: 'u64', component: `${entity}.timestamp_ns` },
      { offset: 8, size: 1, type: 'u8', component: `${entity}.channel_id` },
      { offset: 9, size: 1, type: 'u8', component: `${entity}.actuator_state_commanded` },
    ]);
    if (client.sendRawMessage(vtableMsgId, ElodinPacketType.MSG, vt)) ok++;
  }
  if (ok > 0) console.log(`[VTable] Actuator commanded VTables: ${ok}/20 registered`);
  return ok > 0;
}

// ── Shared helpers ─────────────────────────────────────────────────────

/**
 * Compute FNV-1a hash for Elodin message type name (matching db.hpp msg_id).
 *
 * fnv1a_hash_32: offset 0x811c9dc5, prime 0x01000193, max 31 chars
 * fnv1a_hash_16_xor: XORs upper and lower 16 bits
 * msg_id: returns [hash & 0xff, (hash >> 8) & 0xff]
 */
export function computeMsgId(typeName: string): [number, number] {
  const FNV_OFFSET_BASIS = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;

  let hash = FNV_OFFSET_BASIS;
  const maxLen = Math.min(typeName.length, 31);

  for (let i = 0; i < maxLen; i++) {
    hash ^= typeName.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  const xorHash = ((hash >>> 16) & 0xFFFF) ^ (hash & 0xFFFF);
  return [xorHash & 0xFF, (xorHash >>> 8) & 0xFF];
}

interface VTableField {
  offset: number;
  size: number;
  type: string;
  component: string;
}

const TYPE_MAP: Record<string, number> = {
  u64: 0, f64: 1, f32: 2, u32: 3, i32: 4, u8: 5,
};

function encodeVTable(packetId: [number, number], fields: VTableField[]): Buffer {
  const buffer = Buffer.alloc(1024);
  let off = 0;

  buffer.writeUInt8(packetId[0], off++);
  buffer.writeUInt8(packetId[1], off++);
  buffer.writeUInt8(fields.length, off++);

  for (const field of fields) {
    buffer.writeUInt32LE(field.offset, off); off += 4;
    buffer.writeUInt32LE(field.size, off);   off += 4;
    buffer.writeUInt8(TYPE_MAP[field.type] ?? 0, off++);
    const nameBytes = Buffer.from(field.component, 'utf-8');
    buffer.writeUInt8(nameBytes.length, off++);
    nameBytes.copy(buffer, off);
    off += nameBytes.length;
  }

  return buffer.subarray(0, off);
}
