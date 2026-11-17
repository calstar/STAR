/**
 * server/calibration-state.ts — the backend's half of calibration.
 *
 * Owns the PT coefficient map loaded at startup, the accumulated calibration points, the raw-ADC
 * tracker (`lastRawAdc`, filled through noteRawAdc() from ingest) and the `CalibrationHost`
 * handed to calibration-handler.ts. initCalibrationState() is the startup read (§1.2 rows 7-9:
 * the PT load and its log line, the sensor-role map, then the host object — the host copies
 * ptCalibrationFilePath by value, so it must be built after the load; frozen in
 * pipeline/golden/ws_events.txt `calibration_command`). reloadCalibrationEntityMap() is the
 * deploy-time rebuild of the role map, in lockstep with the host's channelToEntityMap.
 *
 * `calibrationHost` is an `export let` assigned only here; its `.elodin` is still set by
 * elodin-link.onElodinConnected in step 1 (R3) — step 2.2 adds setCalibrationElodin(). No effect
 * at import (M1). Never imports api-server.ts or api/*.
 *
 * Contract: calibration/golden/ts.txt freezes calibration-handler.ts against a stub host (incl.
 * publishCalibrationReload / publishClearAllTares bytes); the `Loaded N PT calibrations` line is
 * startup-log order (G12).
 */

import { loadPTCalibration, type CalibrationCoefficients } from '../calibration.js';
import type { CalibrationHost } from '../calibration-handler.js';
import { loadSensorRoleMap } from '../sensor-config.js';
import { send, broadcast } from './ws-clients.js';
import { uniqueIdFromPtEntity } from './config-caches.js';

// ── Calibration state ────────────────────────────────────────────────────────

const ptCalibration = new Map<number, CalibrationCoefficients>();
const calibrationPoints = new Map<number, { adc: number; pressure: number }[]>();
const lastRawAdc = new Map<number, number>();
let ptCalibrationFilePath: string | null = null;

// Sensor-role → entity naming. Rebuilt on config save (onConfigUpdated) so a
// Sensor Roles edit reflects without a backend restart. calibrationHost reads
// this via its channelToEntityMap property (updated in lockstep below).
let calChannelToEntityMap: Record<number, string>;

export let calibrationHost: CalibrationHost;

/** The startup reads, in today's order: PT calibration file (logged), sensor-role map, then the host. */
export function initCalibrationState(): void {
  // Load existing calibration file if available
  try {
    const loaded = loadPTCalibration();
    if (loaded.map.size > 0) {
      for (const [k, v] of loaded.map) ptCalibration.set(k, v);
      ptCalibrationFilePath = loaded.filePath;
      console.log(`[ThinServer] Loaded ${ptCalibration.size} PT calibrations from ${loaded.filePath}`);
    }
  } catch { /* no calibration file — fine */ }

  calChannelToEntityMap = loadSensorRoleMap().channelToEntityMap;

  calibrationHost = {
    ptCalibration,
    ptCalibrationFilePath,
    calibrationPoints,
    channelToEntityMap: calChannelToEntityMap,
    lastRawAdc,
    send,
    broadcast,
    elodin: null as any, // Will be set after elodin connection
  };
}

/** Rebuild sensor-role-derived caches so a Sensor Roles / board_id edit reflects
 *  live (the backend is always-on and isn't restarted by a session start). */
export function reloadCalibrationEntityMap(): void {
  calChannelToEntityMap = loadSensorRoleMap().channelToEntityMap;
  calibrationHost.channelToEntityMap = calChannelToEntityMap;
}

/** A `raw_adc_counts` row (ingest, step 2.1): uniqueId = board_id*100+channel, same as calibration_service. */
export function noteRawAdc(entity: string, value: number): void {
  const uid = uniqueIdFromPtEntity(entity);
  if (uid != null) lastRawAdc.set(uid, value);
}
