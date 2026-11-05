/**
 * Motorized ball valves: what shows under one in place of an actuator's current.
 *
 * Its board reports where the ball is (position_pct on BV<n>_Cal.CH<m>, 0 closed, 100 open, with
 * cal_status 2 when the 4-20 mA loop is dead). Shown against the command, so the number reads as
 * progress toward what was asked: % OPEN while commanded open, % CLOSED while commanded closed.
 */
import { ActuatorState } from './types';

/** cal_status on [0x34]: the loop is below 3.5 mA (calibration/ValvePosition.hpp). */
export const BALL_VALVE_STATUS_NO_SIGNAL = 2;

export function formatBallValvePosition(
  pct: number | null,
  status: number | null,
  commanded: ActuatorState | null,
): string {
  if (status === BALL_VALVE_STATUS_NO_SIGNAL) return 'NO SIGNAL';
  if (pct == null || !Number.isFinite(pct)) return '--- %';
  const open = Math.min(100, Math.max(0, pct));
  if (commanded === ActuatorState.CLOSED) return `${Math.round(100 - open)}% CLOSED`;
  return `${Math.round(open)}% OPEN`;
}
