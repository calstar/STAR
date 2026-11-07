/**
 * How fast the stand runs against the wall clock, as the top bar says it:
 * stand seconds per wall second over a window of about a second, so it reads
 * steadily. Pure, for stand.tsx; tested in pace.test.ts.
 *
 * A window measures one pacing: one run of the tick (pausing ends it) at one
 * time warp. A tick under another pacing starts a new window and claims
 * nothing until it has run. One window used to span them all: the first tick
 * after a ten-second pause read 0.02 stand seconds per wall second, and ×1 to
 * ×20 read 1.0 against 20 asked, and for a second the top bar called the
 * stand too stiff to integrate in real time.
 */

/** Wall time a window spans before it gives a speed [ms]. */
export const PACE_WINDOW_MS = 1000;

export interface PaceWindow {
  /** Wall clock at the window's start [ms]. */
  wall: number;
  /** Stand time at the window's start [s]. */
  t: number;
  /** The pacing it measures: which run of the tick, at which warp. */
  pacing: string;
}

/** One tick landed at `wall` [ms] with the stand at `t` [s], under `pacing`.
 *  The window to keep; the speed it measured when it closed, else null; and
 *  `fresh` when this tick started a window, so nothing measured yet stands. */
export function paceTick(
  window: PaceWindow | null,
  wall: number,
  t: number,
  pacing: string,
): { window: PaceWindow; speed: number | null; fresh: boolean } {
  if (!window || window.pacing !== pacing) return { window: { wall, t, pacing }, speed: null, fresh: true };
  if (wall - window.wall <= PACE_WINDOW_MS) return { window, speed: null, fresh: false };
  const ratio = (t - window.t) / ((wall - window.wall) / 1000);
  return { window: { wall, t, pacing }, speed: Number.isFinite(ratio) && ratio >= 0 ? ratio : null, fresh: false };
}
