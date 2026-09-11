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
export function secondsLeft(state: CheckoutState, nowMs: number): number | null {
  if (!state.lockedByMe || !state.lockExpiresAt) return null;
  const at = Date.parse(state.lockExpiresAt);
  if (!Number.isFinite(at)) return null; // unparseable: show no countdown, not NaN
  return Math.max(0, Math.round((at - nowMs) / 1000));
}

/** Whether the bar should turn amber and offer to keep the hold. */
export function isExpiringSoon(state: CheckoutState, nowMs: number): boolean {
  const left = secondsLeft(state, nowMs);
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
  nowMs: number,
  idleCapMs: number,
): boolean {
  return nowMs - lastActivityMs < idleCapMs;
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
