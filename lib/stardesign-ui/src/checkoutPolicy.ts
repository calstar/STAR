/**
 * The decisions a live checkout makes, as pure functions.
 *
 * These live outside `useCheckout` so they can be tested without a DOM: the
 * repo has no jsdom or testing-library anywhere, and the bugs worth pinning
 * here are arithmetic and precedence, not rendering. The hook is then only
 * wiring — timers, listeners and `setState` — around decisions made here.
 */

import type { CheckoutState } from './api';

/** Below this many seconds the bar warns and offers "Keep editing". */
export const WARN_AT_S = 120;

/**
 * Seconds until the hold lapses, or null when the question does not apply.
 *
 * Null rather than 0 when we do not hold it: a countdown on someone else's
 * checkout would be both wrong and none of our business. Clamped at 0 because a
 * negative countdown reads as a bug, and the server is the authority on whether
 * it has actually gone.
 */
export function secondsLeft(
  state: CheckoutState,
  nowMs: number,
  receivedAtMs?: number,
): number | null {
  if (!state.lockedByMe) return null;

  // Preferred path: the server told us how long is left, and we subtract only
  // locally-measured elapsed time. Both numbers come from the same clock, so
  // any disagreement between our clock and the server's cancels out entirely.
  //
  // Differencing `lockExpiresAt` against our own clock does NOT cancel: a
  // browser 17 hours behind the server showed "1038:44" left on a 15 minute
  // hold, and one running fast would sit at "0:00" with the warning stuck on.
  const remaining = state.lockExpiresInSeconds;
  if (typeof remaining === 'number' && Number.isFinite(remaining) && receivedAtMs !== undefined) {
    const elapsed = Math.max(0, (nowMs - receivedAtMs) / 1000);
    return Math.max(0, Math.round(remaining - elapsed));
  }

  // Fallback for a server that does not send the duration yet. Same skew
  // exposure as before, which is why it is second.
  if (!state.lockExpiresAt) return null;
  const at = Date.parse(state.lockExpiresAt);
  if (!Number.isFinite(at)) return null; // unparseable: show no countdown, not NaN
  return Math.max(0, Math.round((at - nowMs) / 1000));
}

/** Whether the bar should turn amber and offer to keep the hold. */
export function isExpiringSoon(
  state: CheckoutState,
  nowMs: number,
  receivedAtMs?: number,
): boolean {
  const left = secondsLeft(state, nowMs, receivedAtMs);
  return left !== null && left <= WARN_AT_S;
}

/**
 * Should the next tick beat the hold, or merely observe it?
 *
 * Beating on recent interaction is the fix for "it kicked me out while I was
 * working". The idle cap is what stops a design left open on an unattended
 * machine being held forever — release is holder-only and the on-close beacon
 * is best-effort, so lapsing is the only thing that recovers a checkout after a
 * crash or a power cut.
 */
export function shouldBeat(
  lastActivityMs: number,
  lastBeatAtMs: number,
  visible = true,
): boolean {
  // Not while the tab is hidden. A backgrounded tab still runs its timers, so
  // without this a parked window refreshes the hold forever and nobody else can
  // ever take the design. Note this only declines to REFRESH -- it must never
  // release, which is the bug that made a three-second glance at another tab
  // cost you the design.
  if (!visible) return false;

  // Refresh because something happened SINCE the last refresh -- not because
  // something happened within some generous window.
  //
  // The window version was wrong in a way that looked right in tests and awful in
  // use: it kept the hold alive while the last interaction was under `idleCapMs`
  // old, and `idleCapMs` was the lock's own 15 minute TTL. So one press of Take
  // licensed fifteen minutes of automatic refreshing, the countdown snapped back
  // to 15:00 every tick, and a user sitting still watched it bounce 15:00 -> 14:45
  // -> 15:00 forever without touching anything.
  //
  // "Since the last beat" needs no cap and no tuning: do something and the next
  // tick refreshes; stop, and the countdown runs down honestly to zero and the
  // design frees itself.
  return lastActivityMs > lastBeatAtMs;
}

/**
 * Did we just lose a hold we did not give up?
 *
 * Only a transition from held to not-held counts. Never holding it is not a
 * loss, and neither is releasing it on purpose — the hook calls this only for
 * server-driven changes, and a deliberate `release()` bypasses it entirely.
 */
export function isUnexpectedLoss(prev: CheckoutState, next: CheckoutState): boolean {
  return prev.lockedByMe && !next.lockedByMe;
}

/** `m:ss`, for the countdown chip. */
export function mmss(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(safe / 60);
  return `${m}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * Is this page served from the developer's own machine?
 *
 * On a dev box the checkout has no colleague to protect: the only person who
 * can hold the design is the one at the keyboard, so every rule that exists to
 * free a design for someone else -- press Take, lapse when idle, be told when
 * it goes -- is pure friction. `useCheckout` uses this to take the design on
 * open, keep it while the tab lives, and take it straight back if it lapses.
 * Deployed, none of that applies and the model above is in force.
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}
