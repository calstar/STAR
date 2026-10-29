/**
 * Motorized ball valve boards (type BALL_VALVE): what their position readback says about the valve.
 *
 * A ball valve is commanded like any actuator, but where an actuator board reports a current, this
 * board reports where the ball actually is: calibration_service publishes position_pct (0 closed,
 * 100 open) on [0x34] as BV<n>_Cal.CH<m>, with cal_status 2 when the 4-20 mA loop is below 3.5 mA.
 *
 * For the actuator-mismatch check a position is only OPEN or CLOSED near the end of travel. A
 * valve part-way is travelling (it takes a few seconds), and a dead loop says nothing — neither
 * counts as sensed, so neither can raise a mismatch on its own.
 */

/** At or above this the valve counts as sensed OPEN. */
export const BALL_VALVE_OPEN_PCT = 95;
/** At or below this the valve counts as sensed CLOSED. */
export const BALL_VALVE_CLOSED_PCT = 5;
/** cal_status on [0x34]: the position loop is open or unpowered (calibration/ValvePosition.hpp). */
export const BALL_VALVE_STATUS_NO_SIGNAL = 2;

/** 1 = open, 0 = closed, undefined = travelling, no signal, or not a number. */
export function sensedStateFromPosition(pct: number, status?: number): 0 | 1 | undefined {
  if (status === BALL_VALVE_STATUS_NO_SIGNAL || !Number.isFinite(pct)) return undefined;
  if (pct >= BALL_VALVE_OPEN_PCT) return 1;
  if (pct <= BALL_VALVE_CLOSED_PCT) return 0;
  return undefined;
}

/**
 * BV<n>_Cal.CH<m> → BV<n>.CH<m>: the key the mismatch check reads, which is what
 * resolveActuatorTelemetryEntity gives a ball valve role. Null for anything else.
 */
export function ballValveSensedEntity(calEntity: string): string | null {
  const m = /^BV(\d+)_Cal\.CH(\d+)$/.exec(calEntity);
  return m ? `BV${m[1]}.CH${m[2]}` : null;
}

/** board_ids of every [boards.*] with type BALL_VALVE, enabled or not. */
export function ballValveBoardIds(config: { boards?: unknown } | null | undefined): Set<number> {
  const ids = new Set<number>();
  const boards = (config?.boards && typeof config.boards === 'object') ? config.boards as Record<string, any> : {};
  for (const b of Object.values(boards)) {
    if (String(b?.type ?? '').toUpperCase() !== 'BALL_VALVE') continue;
    const id = Number(b?.board_id ?? b?.id);
    if (Number.isInteger(id)) ids.add(id);
  }
  return ids;
}
