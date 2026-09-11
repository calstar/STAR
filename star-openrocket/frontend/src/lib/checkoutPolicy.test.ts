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
/** A hold the server says has `remaining` seconds left on it. */
const heldFor = (remaining: number | null, expiresAt: string | null = null): CheckoutState => ({
  ...held(expiresAt),
  lockExpiresInSeconds: remaining,
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


describe('secondsLeft is immune to clock skew', () => {
  // The bug: the countdown differenced a server timestamp against the browser's
  // own clock. A browser 17 hours behind the server showed "1038:44" left on a
  // 15 minute hold. A browser running fast is worse -- it reads 0:00 and pins
  // the warning on, which looks exactly like the lapsing bug this work fixes.
  const SKEW = 17 * 3600 * 1000;

  it('uses the server-measured duration, not the two clocks', () => {
    // Our clock is 17h behind; the absolute expiry would compute ~17h left.
    const state = heldFor(900, at(900 + 17 * 3600));
    expect(secondsLeft(state, NOW, NOW)).toBe(900);
  });

  it('is unaffected whichever way the skew runs', () => {
    const slow = heldFor(900, new Date(NOW + 900_000 + SKEW).toISOString());
    const fast = heldFor(900, new Date(NOW + 900_000 - SKEW).toISOString());
    expect(secondsLeft(slow, NOW, NOW)).toBe(900);
    expect(secondsLeft(fast, NOW, NOW)).toBe(900);
  });

  it('counts down by locally-measured elapsed time', () => {
    const state = heldFor(900);
    expect(secondsLeft(state, NOW + 60_000, NOW)).toBe(840);
    expect(secondsLeft(state, NOW + 900_000, NOW)).toBe(0);
    expect(secondsLeft(state, NOW + 950_000, NOW)).toBe(0); // clamped
  });

  it('falls back to the timestamp when the server sends no duration', () => {
    // An older server, or a response that predates the field.
    expect(secondsLeft(held(at(300)), NOW, NOW)).toBe(300);
  });

  it('ignores the duration when we do not hold it', () => {
    expect(secondsLeft({ ...heldFor(900), lockedByMe: false }, NOW, NOW)).toBeNull();
  });

  it('drives the warning off the same skew-proof number', () => {
    const nearly = heldFor(30, at(30 + 17 * 3600));
    expect(isExpiringSoon(nearly, NOW, NOW)).toBe(true);
    expect(isExpiringSoon(heldFor(600), NOW, NOW)).toBe(false);
  });
});


describe('an untouched or backgrounded tab must stop refreshing the hold', () => {
  const CAP = 15 * 60_000;

  it('never beats when nothing has been touched at all', () => {
    // The hook seeds lastActivity at 0, not the mount time. Seeding it with
    // Date.now() meant merely opening the page bought a full idle window, so
    // the 15 s tick refreshed the lock the whole time and the countdown read a
    // fresh 15:00 every time the user came back to the tab.
    expect(shouldBeat(0, NOW, CAP)).toBe(false);
  });

  it('beats once something actually happens, and stops when it ages out', () => {
    expect(shouldBeat(NOW, NOW, CAP)).toBe(true);
    expect(shouldBeat(NOW - CAP - 1, NOW, CAP)).toBe(false);
  });

  it('does not beat while the tab is hidden, however recent the interaction', () => {
    // A backgrounded tab still runs its timers, so without this a parked window
    // holds the design against everybody else forever.
    expect(shouldBeat(NOW, NOW, CAP, false)).toBe(false);
  });

  it('declining to refresh is not the same as releasing', () => {
    // The distinction that matters: hiding the tab must stop the hold being
    // renewed, never hand it back. Releasing on visibilitychange is what made a
    // three-second glance at another tab cost someone their design.
    expect(shouldBeat(NOW, NOW, CAP, true)).toBe(true);
    expect(shouldBeat(NOW, NOW + 1000, CAP, true)).toBe(true);
  });
});
