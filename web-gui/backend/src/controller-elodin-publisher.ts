/**
 * @file controller-elodin-publisher.ts
 * @brief Publishes controller outputs to Elodin DB for logging and replay
 *
 * This module encodes controller actuation commands and diagnostics into
 * Elodin DB TABLE packet format and publishes them to the database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { ElodinClient } from './elodin-client.js';
import type { ElodinRelayClient } from './elodin-relay-client.js';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const STATE_CSV = path.join(_dir, '..', '..', '..', 'data', 'state_transitions.csv');

function appendStateToCsvFallback(timestampMs: number, toState: number): void {
  try {
    const dir = path.dirname(STATE_CSV);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const exists = fs.existsSync(STATE_CSV);
    const line = `${timestampMs},${toState}\n`;
    if (!exists) fs.writeFileSync(STATE_CSV, 'timestamp_ms,to_state\n');
    fs.appendFileSync(STATE_CSV, line);
  } catch (_) { /* ignore */ }
}

type PublishTarget = { publishTable(packetId: [number, number], payload: Buffer): boolean; isConnected?(): boolean };
function getPublishTarget(elodin: ElodinClient, relay: ElodinRelayClient | null): PublishTarget | null {
  const relayOk = relay?.isConnected() ?? false;
  const elodinOk = elodin.isConnected();
  // Prefer relay: Elodin DB streams to first subscriber only; relay has that connection.
  // Direct elodin may connect but writes can be ignored.
  if (relayOk) return relay;
  if (elodinOk) return elodin;
  console.warn(`[ControllerElodinPublisher] No publish target: elodin=${elodinOk} relay=${relayOk}`);
  return null;
}

/**
 * Encode ControllerActuationMessage for Elodin DB
 * Format matching ControllerMessages.hpp:
 * uint64_t timestamp_ns (8) + float duty_F (4) + float duty_O (4) +
 * uint8_t u_F_on (1) + uint8_t u_O_on (1) + uint8_t valid (1) = 19 bytes
 */
export function encodeControllerActuation(
  timestampNs: bigint,
  dutyF: number,
  dutyO: number,
  uFOn: boolean,
  uOOn: boolean,
  valid: boolean
): Buffer {
  const buffer = Buffer.alloc(19);

  // uint64_t timestamp_ns (little-endian)
  buffer.writeBigUInt64LE(timestampNs, 0);

  // float duty_F (little-endian)
  buffer.writeFloatLE(dutyF, 8);

  // float duty_O (little-endian)
  buffer.writeFloatLE(dutyO, 12);

  // uint8_t u_F_on
  buffer.writeUInt8(uFOn ? 1 : 0, 16);

  // uint8_t u_O_on
  buffer.writeUInt8(uOOn ? 1 : 0, 17);

  // uint8_t valid
  buffer.writeUInt8(valid ? 1 : 0, 18);

  return buffer;
}

/**
 * Encode ControllerDiagnosticsMessage for Elodin DB
 * Format matching ControllerMessages.hpp:
 * uint64_t timestamp_ns (8) + double F_ref (8) + double MR_ref (8) +
 * double F_estimated (8) + double MR_estimated (8) + double P_ch (8) +
 * double cost (8) + uint8_t safety_filtered (1) + uint8_t cutoff_active (1) +
 * int32_t solver_iters (4) = 62 bytes
 */
export function encodeControllerDiagnostics(
  timestampNs: bigint,
  fRef: number,
  mrRef: number,
  fEstimated: number,
  mrEstimated: number,
  pCh: number,
  cost: number,
  safetyFiltered: boolean,
  cutoffActive: boolean,
  solverIters: number
): Buffer {
  const buffer = Buffer.alloc(62);

  // uint64_t timestamp_ns (little-endian)
  buffer.writeBigUInt64LE(timestampNs, 0);

  // double F_ref (little-endian)
  buffer.writeDoubleLE(fRef, 8);

  // double MR_ref (little-endian)
  buffer.writeDoubleLE(mrRef, 16);

  // double F_estimated (little-endian)
  buffer.writeDoubleLE(fEstimated, 24);

  // double MR_estimated (little-endian)
  buffer.writeDoubleLE(mrEstimated, 32);

  // double P_ch (little-endian)
  buffer.writeDoubleLE(pCh, 40);

  // double cost (little-endian)
  buffer.writeDoubleLE(cost, 48);

  // int32_t solver_iters at offset 56 (4-byte aligned, matching C++ ControllerDiagnosticsMessage)
  buffer.writeInt32LE(solverIters, 56);

  // uint8_t safety_filtered at offset 60
  buffer.writeUInt8(safetyFiltered ? 1 : 0, 60);

  // uint8_t cutoff_active at offset 61
  buffer.writeUInt8(cutoffActive ? 1 : 0, 61);

  return buffer;
}

/**
 * Publish controller actuation to Elodin DB
 */
export function publishControllerActuation(
  elodin: ElodinClient,
  dutyF: number,
  dutyO: number,
  uFOn: boolean,
  uOOn: boolean,
  valid: boolean
): boolean {
  if (!elodin.isConnected()) {
    return false;
  }

  try {
    const timestampNs = BigInt(Date.now()) * BigInt(1_000_000); // Convert ms to ns
    const payload = encodeControllerActuation(timestampNs, dutyF, dutyO, uFOn, uOOn, valid);

    // Packet ID: [0x40, 0x00] for controller actuation
    return elodin.publishTable([0x40, 0x00], payload);
  } catch (error) {
    console.error('[ControllerElodinPublisher] ❌ Failed to publish actuation:', error);
    return false;
  }
}

/**
 * Publish controller diagnostics to Elodin DB
 */
export function publishControllerDiagnostics(
  elodin: ElodinClient,
  fRef: number,
  mrRef: number,
  fEstimated: number,
  mrEstimated: number,
  pCh: number,
  cost: number,
  safetyFiltered: boolean,
  cutoffActive: boolean,
  solverIters: number
): boolean {
  if (!elodin.isConnected()) {
    return false;
  }

  try {
    const timestampNs = BigInt(Date.now()) * BigInt(1_000_000); // Convert ms to ns
    const payload = encodeControllerDiagnostics(
      timestampNs,
      fRef,
      mrRef,
      fEstimated,
      mrEstimated,
      pCh,
      cost,
      safetyFiltered,
      cutoffActive,
      solverIters
    );

    // Packet ID: [0x41, 0x00] for controller diagnostics
    return elodin.publishTable([0x41, 0x00], payload);
  } catch (error) {
    console.error('[ControllerElodinPublisher] ❌ Failed to publish diagnostics:', error);
    return false;
  }
}

/**
 * Publish PSM state transition to Elodin DB [0x43, 0x00]
 * Format: U64 timestamp_ns | U8 from_state | U8 to_state | U8 reason (11 bytes)
 * Uses relay when direct Elodin connection is down (relay has the DB connection).
 */
export function publishControllerStateTransition(
  elodin: ElodinClient,
  fromState: number,
  toState: number,
  reason: number = 0,
  relay: ElodinRelayClient | null = null
): boolean {
  const target = getPublishTarget(elodin, relay);
  if (!target) {
    console.warn('[ControllerElodinPublisher] ⚠️ State transition NOT saved: Elodin DB and relay not connected');
    return false;
  }
  const via = elodin.isConnected() ? 'elodin' : 'relay';
  try {
    const timestampNs = BigInt(Date.now()) * BigInt(1_000_000);
    const buffer = Buffer.alloc(11);
    buffer.writeBigUInt64LE(timestampNs, 0);
    buffer.writeUInt8(fromState, 8);
    buffer.writeUInt8(toState, 9);
    buffer.writeUInt8(reason, 10);
    const ok = target.publishTable([0x43, 0x00], buffer);
    const timestampMs = Date.now();
    appendStateToCsvFallback(timestampMs, toState);
    if (ok) {
      console.log(`[ControllerElodinPublisher] ✅ State transition published: ${fromState}→${toState} [0x43,0x00] via ${via}`);
    } else {
      console.warn(`[ControllerElodinPublisher] ⚠️ publishTable returned false (via ${via}) — saved to ${STATE_CSV}`);
    }
    return ok;
  } catch (error) {
    console.error('[ControllerElodinPublisher] ❌ Failed to publish state transition:', error);
    return false;
  }
}

/**
 * Elodin table low byte for [0x32, lo]: (board_slot - 1) * 0x20 + local_channel;
 * slot = board_id % 10, 0 → 10. Matches FSW ActuatorCommander::actuator_elodin_low_byte.
 */
export function actuatorElodinLowByte(boardId: number, localChannel: number): number {
  const slot = (boardId >>> 0) % 10;
  const bn = slot === 0 ? 10 : slot;
  return ((bn - 1) * 0x20 + localChannel) & 0xff;
}

/**
 * Publish commanded actuator state to Elodin DB [0x32, lowByte]
 * Format: U64 timestamp_ns | U8 channel_id (global low) | U8 actuator_state (10 bytes)
 * Uses [0x32] (commanded) not [0x31] (current-sense). Uses relay when direct Elodin down.
 */
export function publishActuatorStateToElodin(
  elodin: ElodinClient,
  boardId: number,
  localChannel: number,
  actuatorState: number,
  relay: ElodinRelayClient | null = null
): boolean {
  const target = getPublishTarget(elodin, relay);
  if (!target) return false;
  if (localChannel < 1 || localChannel > 32) return false;
  const low = actuatorElodinLowByte(boardId, localChannel);
  if (low < 1) return false;
  try {
    const timestampNs = BigInt(Date.now()) * BigInt(1_000_000);
    const buffer = Buffer.alloc(10);
    buffer.writeBigUInt64LE(timestampNs, 0);
    buffer.writeUInt8(low, 8);
    buffer.writeUInt8(actuatorState === 1 ? 1 : 0, 9); // 0=closed/off, 1=open/on
    return target.publishTable([0x32, low], buffer);
  } catch (error) {
    console.error('[ControllerElodinPublisher] ❌ Failed to publish actuator state:', error);
    return false;
  }
}
