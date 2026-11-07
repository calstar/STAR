/**
 * Motorized ball valves: what shows under one in place of an actuator's current.
 *
 * Its board reports where the ball is (position_pct on BV<n>_Cal.CH<m>, 0 closed, 100 open, with
 * cal_status 2 when the 4-20 mA loop is dead). Shown against the command, so the number reads as
 * progress toward what was asked: % OPEN while commanded open, % CLOSED while commanded closed.
 */
import { ActuatorState } from './types';

/** cal_status on [0x34]: the loop is below 2 mA (calibration/ValvePosition.hpp). */
export const BALL_VALVE_STATUS_NO_SIGNAL = 2;

/**
 * Loop current from the board's raw 12-bit reading: 3.3 V full scale across the 100 ohm shunt
 * (calibration/ValvePosition.hpp). As the board reads it, so it carries the ESP32 ADC's ~1 mA low
 * offset at this end; it is shown so a dead loop can be told from a valve reading a little low.
 */
export function loopMilliamps(rawCounts: number): number {
  return (rawCounts / 4095) * 3.3 / 100 * 1000;
}

export function formatBallValvePosition(
  pct: number | null,
  status: number | null,
  commanded: ActuatorState | null,
  rawCounts?: number | null,
): string {
  const ma = rawCounts != null && Number.isFinite(rawCounts) ? `, ${loopMilliamps(rawCounts).toFixed(1)} mA` : '';
  if (status === BALL_VALVE_STATUS_NO_SIGNAL) return `NO SIGNAL${ma}`;
  if (pct == null || !Number.isFinite(pct)) return '--- %';
  const open = Math.min(100, Math.max(0, pct));
  if (commanded === ActuatorState.CLOSED) return `${Math.round(100 - open)}% CLOSED${ma}`;
  return `${Math.round(open)}% OPEN${ma}`;
}
