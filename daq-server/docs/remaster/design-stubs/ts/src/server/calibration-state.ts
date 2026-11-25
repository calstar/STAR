/**
 * server/calibration-state — the backend's half of calibration: PT coefficients loaded at start,
 * raw-ADC tracking, and the `CalibrationHost` handed to `calibration-handler.ts`.
 * [WP6 1.9, layer 3]
 *
 * Owns: `calibrationHost` and the maps it carries (`ptCalibration`, `calibrationPoints`,
 * `lastRawAdc`, `channelToEntityMap`). `CalibrationHost` is `calibration-handler.ts`'s existing
 * interface with two users (this backend and `calibration/ts_harness.mts`), kept as is.
 * After step 2.2 the only writer of `calibrationHost.elodin` (STYLE-S32).
 * Must not know about: the calibration commands themselves (`calibration-handler.ts`), Elodin
 * connection policy (`elodin-link`), HTTP. Imports `ws-clients` (`send`, `broadcast` for the
 * host), `calibration`, `sensor-config`, `config-caches` (step 2.1, for `noteRawAdc`).
 * Contract: the host is built **after** the PT load and copies `ptCalibrationFilePath` by value
 * (frozen in `pipeline/golden/ws_events.txt` `calibration_command`; `calibration/golden/ts.txt`
 * for the handler's bytes). Three calibration stores exist (C3-3, C5-5): Parked.
 * Import-time effects: none; `initCalibrationState()` at WP6 §1.3 row 7.
 */

import type { CalibrationHost, ElodinClient } from '../product-types.js';

/** Live binding; built inside `initCalibrationState()`. */
export declare let calibrationHost: CalibrationHost;
/** [step 1 only] uniqueId → last raw ADC count; written by `ingest` until 2.1. */
export declare const lastRawAdc: Map<number, number>;

/** Row 7: `loadPTCalibration()` (logs `Loaded N PT calibrations from …` when any; a throw is
 *  swallowed — no file is fine), the sensor-role map, then the host object. */
export function initCalibrationState(): void {
  throw new Error('stub');
}

/** After a deploy: rebuild the role → entity map and point the host at it (two statements). */
export function reloadCalibrationEntityMap(): void {
  throw new Error('stub');
}

/** [step 2.1] A `raw_adc_counts` row: `lastRawAdc[uniqueIdFromPtEntity(entity)] = value` when
 *  the id resolves. */
export function noteRawAdc(entity: string, value: number): void {
  throw new Error('stub');
}

/** [step 2.2] `calibrationHost.elodin = client`, called by `elodin-link.onElodinConnected`.
 *  Until the first connect the field is null and `publishCalibrationReload` is a no-op (frozen). */
export function setCalibrationElodin(client: ElodinClient): void {
  throw new Error('stub');
}
