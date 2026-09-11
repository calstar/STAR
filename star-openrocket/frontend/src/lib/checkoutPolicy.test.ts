/**
 * The decisions a live checkout makes.
 *
 * These are pinned because the bugs they replace were all arithmetic or
 * precedence, and every one of them was invisible in the UI until someone lost
 * a design over it:
 *
 * - `lockExpiresAt` used to carry the raw heartbeat, a timestamp already in the
 *   past, so any countdown read as expired the instant it rendered.
 * - "Activity" used to mean "a successful autosave", so reading a result or
 *   measuring something counted as idle and the design was taken mid-task.
 * - A lapse used to be indistinguishable from never having held it, so the user
 *   was never told.
 */

import { describe, it, expect } from 'vitest';
import {
  WARN_AT_S,
  secondsLeft,
  isExpiringSoon,
  shouldBeat,
  isUnexpectedLoss,
  mmss,
} from '@stardesign-ui/checkoutPolicy';
import type { CheckoutState } from '@stardesign-ui/api';

const NOW = Date.parse('2026-09-11T12:00:00.000Z');
const at = (offsetS: number) => new Date(NOW + offsetS * 1000).toISOString();

const held = (expiresAt: string | null): CheckoutState => ({
  lockedBy: 'me@berkeley.edu',
  lockedByName: 'Me',
  lockedByMe: true,
  lockExpiresAt: expiresAt,
  lockTtlSeconds: 900,
});
const theirs: CheckoutState = {
  lockedBy: 'them@berkeley.edu',
  lockedByName: 'Them',
  lockedByMe: false,
  lockExpiresAt: at(600),
  lockTtlSeconds: 900,
};
const free: CheckoutState = {
  lockedBy: null,
  lockedByName: null,
  lockedByMe: false,
  lockExpiresAt: null,
  lockTtlSeconds: 900,
};

describe('secondsLeft', () => {
  it('counts down a hold we actually have', () => {
    expect(secondsLeft(held(at(271)), NOW)).toBe(271);
  });

  it('is null for a hold that is not ours — not a countdown on someone else', () => {
    expect(secondsLeft(theirs, NOW)).toBeNull();
    expect(secondsLeft(free, NOW)).toBeNull();
  });

  it('clamps at zero rather than going negative', () => {
    // A negative countdown reads as a bug; the server decides whether it is
    // really gone, and the held-poll is what finds out.
    expect(secondsLeft(held(at(-30)), NOW)).toBe(0);
  });

  it('returns null on an unparseable expiry instead of NaN', () => {
    // NaN would render as "NaN:NaN" in the chip. This is the guard for it.
    expect(secondsLeft(held('not-a-date'), NOW)).toBeNull();
    expect(secondsLeft(held(null), NOW)).toBeNull();
  });

  it('rounds to the nearest second so the chip does not stutter', () => {
    expect(secondsLeft(held(new Date(NOW + 1499).toISOString()), NOW)).toBe(1);
    expect(secondsLeft(held(new Date(NOW + 1500).toISOString()), NOW)).toBe(2);
  });
});

describe('isExpiringSoon', () => {
  it('is quiet with plenty of time left', () => {
    expect(isExpiringSoon(held(at(WARN_AT_S + 1)), NOW)).toBe(false);
  });

  it('warns from exactly the threshold — the boundary is inclusive', () => {
    expect(isExpiringSoon(held(at(WARN_AT_S)), NOW)).toBe(true);
    expect(isExpiringSoon(held(at(1)), NOW)).toBe(true);
  });

  it('never warns about a checkout that is not ours', () => {
    // The warning offers "Keep editing", which would be nonsense — and the
    // amber chip already means "someone else has it" elsewhere in the bar.
    expect(isExpiringSoon({ ...theirs, lockExpiresAt: at(5) }, NOW)).toBe(false);
    expect(isExpiringSoon(free, NOW)).toBe(false);
  });
});

describe('shouldBeat', () => {
  const CAP = 15 * 60_000;

  it('beats while the user has interacted recently', () => {
    // The whole fix: panning, measuring or reading now keeps the hold, where
    // previously only a save did.
    expect(shouldBeat(NOW - 1000, NOW, CAP)).toBe(true);
  });

  it('stops exactly at the cap, so an unattended tab frees the design', () => {
    expect(shouldBeat(NOW - CAP, NOW, CAP)).toBe(false);
    expect(shouldBeat(NOW - CAP + 1, NOW, CAP)).toBe(true);
  });

  it('stops after a long idle', () => {
    expect(shouldBeat(NOW - 60 * 60_000, NOW, CAP)).toBe(false);
  });
});

describe('isUnexpectedLoss', () => {
  it('fires only on held -> not held', () => {
    expect(isUnexpectedLoss(held(at(60)), free)).toBe(true);
    expect(isUnexpectedLoss(held(at(60)), theirs)).toBe(true);
  });

  it('does not fire when we never held it', () => {
    // Otherwise the dialog would greet anyone who merely opened a design
    // somebody else has.
    expect(isUnexpectedLoss(free, theirs)).toBe(false);
    expect(isUnexpectedLoss(theirs, free)).toBe(false);
  });

  it('does not fire while we still hold it', () => {
    expect(isUnexpectedLoss(held(at(600)), held(at(900)))).toBe(false);
  });

  it('does not fire on taking it', () => {
    expect(isUnexpectedLoss(free, held(at(900)))).toBe(false);
  });
});

describe('mmss', () => {
  it('formats a countdown', () => {
    expect(mmss(0)).toBe('0:00');
    expect(mmss(9)).toBe('0:09');
    expect(mmss(61)).toBe('1:01');
    expect(mmss(599)).toBe('9:59');
    expect(mmss(900)).toBe('15:00');
  });

  it('never renders a negative or fractional time', () => {
    expect(mmss(-5)).toBe('0:00');
    expect(mmss(30.7)).toBe('0:30');
  });
});
