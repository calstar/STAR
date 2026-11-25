/**
 * server/calibration-state.ts — the backend's half of calibration.
 *
 * Owns the raw-ADC tracker (`lastRawAdc`, filled through noteRawAdc() from ingest) and the
 * `CalibrationHost` handed to calibration-handler.ts. The backend keeps no PT coefficients of its
 * own: calibration_service converts every PT, and its cubic store is the only PT calibration.
 * initCalibrationState() is the startup read (the sensor-role map, then the host object).
 * reloadCalibrationEntityMap() is the deploy-time rebuild of the role map, in lockstep with the
 * host's channelToEntityMap.
 *
 * `calibrationHost` is an `export let` assigned only here, and this module is its only writer:
 * elodin-link sets `.elodin` through setCalibrationElodin() (step 2.2). No effect
 * at import (M1). Never imports api-server.ts or api/*.
 *
 * Contract: calibration/golden/ts.txt freezes calibration-handler.ts against a stub host (incl.
 * publishCalibrationReload / publishClearAllTares bytes).
 */

import type { CalibrationHost } from '../calibration-handler.js';
import type { ElodinClient } from '../elodin-client.js';
import { loadSensorRoleMap } from '../sensor-config.js';
import { send, broadcast } from './ws-clients.js';
import { uniqueIdFromPtEntity } from './config-caches.js';

// ── Calibration state ────────────────────────────────────────────────────────

const lastRawAdc = new Map<number, number>();

// Sensor-role → entity naming. Rebuilt on config save (onConfigUpdated) so a
// Sensor Roles edit reflects without a backend restart. calibrationHost reads
// this via its channelToEntityMap property (updated in lockstep below).
let calChannelToEntityMap: Record<number, string>;

export let calibrationHost: CalibrationHost;

/** The startup reads, in order: sensor-role map, then the host. */
export function initCalibrationState(): void {
  calChannelToEntityMap = loadSensorRoleMap().channelToEntityMap;

  calibrationHost = {
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

/** `calibrationHost.elodin = client`, from elodin-link.onElodinConnected (step 2.2): until the first
 *  connect the field is null and publishCalibrationReload is a no-op, as today. */
export function setCalibrationElodin(client: ElodinClient): void {
  calibrationHost.elodin = client;
}
