/**
 * @file controller-elodin-publisher.ts
 * @brief Publishes controller outputs to Elodin DB for logging and replay
 *
 * This module encodes controller actuation commands and diagnostics into
 * Elodin DB TABLE packet format and publishes them to the database.
 */

import { ElodinClient } from './elodin-client.js';

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

  // uint8_t safety_filtered
  buffer.writeUInt8(safetyFiltered ? 1 : 0, 56);

  // uint8_t cutoff_active
  buffer.writeUInt8(cutoffActive ? 1 : 0, 57);

  // int32_t solver_iters (little-endian)
  buffer.writeInt32LE(solverIters, 58);

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
