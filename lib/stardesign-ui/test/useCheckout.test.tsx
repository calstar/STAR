/**
 * The checkout hook's wiring: refs, effects, timers and listeners.
 *
 * Every checkout bug that reached a user was in this layer, and none of them was a logic
 * error that `checkoutPolicy.test.ts` could have caught — a pure function is only testable
 * once something hands it the right inputs, and the bugs were in what got handed over:
 *
 *  - `lastActivityRef` seeded with `Date.now()` at mount, so merely opening the page counted
 *    as interaction: every tick refreshed the lock and the countdown reset to a full 15:00
 *    with nobody touching anything. Found by a user watching a timer.
 *  - `pointermove` in the activity set, so a wandering cursor re-armed the idle window and a
 *    parked tab held the design against everyone else indefinitely.
 *  - the countdown differencing a server timestamp against the browser's own clock, which
 *    displayed "1038:44" left on a 15 minute hold when the two disagreed by 17 hours.
 *
 * Fake timers throughout: the hook's behaviour is defined in minutes, and nobody should have
 * to wait them out.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCheckout } from '../src/useCheckout';
import { ApiError, type CheckoutState, type DesignApi, type DocRef } from '../src/api';

const REF: DocRef = { id: 'design-1', owner: null };

const FREE: CheckoutState = {
  lockedBy: null,
  lockedByName: null,
  lockedByMe: false,
  lockExpiresAt: null,
  lockExpiresInSeconds: null,
  lockTtlSeconds: 900,
};

const MINE: CheckoutState = {
  lockedBy: 'me@berkeley.edu',
  lockedByName: 'Me',
  lockedByMe: true,
  lockExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  lockExpiresInSeconds: 900,
  lockTtlSeconds: 900,
};

const THEIRS: CheckoutState = { ...MINE, lockedBy: 'them@berkeley.edu', lockedByMe: false };

/**
 * A stub that behaves like the server rather than like a constant.
 *
 * This matters more than it looks: the hook polls `getCheckout` whenever it does NOT hold
 * the design, so a stub that always answers "you hold it" silently undoes a release the
 * instant the poll effect re-activates. Holding one piece of state here keeps take /
 * release / beat coherent with each other, the way a real backend is.
 */
function stubApi(initial: CheckoutState = FREE) {
  let server = initial;
  const api = {
    takeCheckout: vi.fn(async () => (server = MINE)),
    releaseCheckout: vi.fn(async () => (server = FREE)),
    releaseCheckoutOnUnload: vi.fn(() => { server = FREE; }),
    getCheckout: vi.fn(async () => server),
    beatCheckout: vi.fn(async () => server),
  };
  /** Change what the server believes, e.g. someone else took it. */
  const set = (s: CheckoutState) => { server = s; };
  return Object.assign(api, { set }) as typeof api & {
    set: (s: CheckoutState) => void;
  } & DesignApi<unknown>;
}

/**
 * Mount already holding the design, WITHOUT pressing Take.
 *
 * This is the page-reload case, and it is the one that exposed the seeding bug: `take()`
 * legitimately stamps activity, so a test that takes first can never show that merely
 * mounting used to count as interaction.
 */
async function mountAlreadyHeld(api: ReturnType<typeof stubApi>, opts: Record<string, unknown> = {}) {
  const view = renderHook(() => useCheckout({ api, ref: REF, ...opts }));
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(view.result.current.held).toBe(true);
  return view;
}

/** Mount and press Take, which counts as interaction. */
async function mountHeld(api: ReturnType<typeof stubApi>, opts: Record<string, unknown> = {}) {
  const view = renderHook(() => useCheckout({ api, ref: REF, ...opts }));
  await act(async () => {
    await view.result.current.take();
  });
  expect(view.result.current.held).toBe(true);
  return view;
}

/** Advance fake time and let the effects' promises settle. */
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const fire = (type: string) =>
  act(() => { window.dispatchEvent(new Event(type)); });

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('keeping the hold alive', () => {
  it('never refreshes a hold nobody has touched', async () => {
    // THE bug: seeding lastActivityRef with the mount time bought a full idle window just
    // for opening the page, so the 15 s tick beat the lock and a user returning to the tab
    // saw a fresh 15:00 every time. Fails against `useRef(Date.now())`.
    const api = stubApi(MINE);
    await mountAlreadyHeld(api);
    api.beatCheckout.mockClear();

    await tick(20 * 60_000);

    expect(api.beatCheckout).not.toHaveBeenCalled();
  });

  it('refreshes once the user actually does something', async () => {
    const api = stubApi();
    await mountHeld(api);
    api.beatCheckout.mockClear();

    await fire('pointerdown');
    await tick(15_000);

    expect(api.beatCheckout).toHaveBeenCalled();
  });

  it.each(['pointerdown', 'keydown', 'wheel'])('counts %s as working', async (evt) => {
    const api = stubApi();
    await mountHeld(api);
    api.beatCheckout.mockClear();

    await fire(evt);
    await tick(15_000);

    expect(api.beatCheckout).toHaveBeenCalled();
  });

  it('does not count a drifting mouse', async () => {
    // pointermove fires on incidental cursor travel. Including it meant a parked tab
    // re-armed the idle window forever, and the idle cap is the only thing that ever frees
    // a design from someone who walked away.
    const api = stubApi(MINE);
    await mountAlreadyHeld(api);
    api.beatCheckout.mockClear();

    await fire('pointermove');
    await tick(15_000);

    expect(api.beatCheckout).not.toHaveBeenCalled();
  });

  it('refreshes once per interaction, not once per tick', async () => {
    // The symptom a user reported: with the design taken and nothing else touched, the
    // countdown bounced 15:00 -> 14:45 -> 15:00 indefinitely. One interaction must buy one
    // refresh, after which the countdown is allowed to run down.
    const api = stubApi();
    await mountHeld(api); // Take counts as the interaction
    await tick(60_000);
    expect(api.beatCheckout).toHaveBeenCalledTimes(1);

    api.beatCheckout.mockClear();
    await tick(10 * 60_000);
    expect(api.beatCheckout).not.toHaveBeenCalled();
  });

  it('refreshes again the moment something new happens', async () => {
    const api = stubApi();
    await mountHeld(api);
    await tick(60_000);
    api.beatCheckout.mockClear();

    await fire('keydown');
    await tick(15_000);

    expect(api.beatCheckout).toHaveBeenCalledTimes(1);
  });
});

describe('a hidden tab', () => {
  const hide = (hidden: boolean) =>
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible');

  it('stops refreshing the hold', async () => {
    const api = stubApi();
    await mountHeld(api);
    await fire('pointerdown'); // recent interaction, so only visibility can stop it
    api.beatCheckout.mockClear();

    hide(true);
    await tick(30_000);

    expect(api.beatCheckout).not.toHaveBeenCalled();
  });

  it('still observes it, so a loss is noticed', async () => {
    const api = stubApi();
    await mountHeld(api);
    api.getCheckout.mockClear();

    hide(true);
    await tick(30_000);

    expect(api.getCheckout).toHaveBeenCalled();
  });

  it('does NOT hand the checkout back', async () => {
    // The distinction the original bug turned on: releasing on visibilitychange meant a
    // three-second glance at another tab cost you the design. Hiding may stop a refresh; it
    // must never release.
    const api = stubApi();
    await mountHeld(api);

    await act(() => { document.dispatchEvent(new Event('visibilitychange')); });

    expect(api.releaseCheckoutOnUnload).not.toHaveBeenCalled();
  });

  it('releases on pagehide, which is a real departure', async () => {
    const api = stubApi();
    await mountHeld(api);

    await fire('pagehide');

    expect(api.releaseCheckoutOnUnload).toHaveBeenCalled();
  });
});

describe('the countdown', () => {
  it('ignores a disagreement between our clock and the server s', async () => {
    // A browser 17 h behind its server displayed "1038:44" left on a 15 minute hold, and one
    // running fast would have sat at 0:00 with the warning pinned on. The duration cancels
    // both, because elapsed time is measured entirely on our own clock.
    const skewed: CheckoutState = {
      ...MINE,
      lockExpiresAt: new Date(Date.now() + 900_000 + 17 * 3600_000).toISOString(),
      lockExpiresInSeconds: 900,
    };
    const api = stubApi(skewed);
    const view = await mountAlreadyHeld(api);

    expect(view.result.current.secondsLeft).toBe(900);
  });

  it('counts down by locally measured time', async () => {
    const api = stubApi(MINE);
    const view = await mountAlreadyHeld(api);
    expect(view.result.current.secondsLeft).toBe(900);

    // Under heldPollMs (15 s), so nothing refreshes it -- we are watching the local clock
    // do the counting, which is the whole point.
    await tick(10_000);

    expect(view.result.current.secondsLeft).toBe(890);
  });

  it('restarts from the server s number after a refresh', async () => {
    const api = stubApi(MINE);
    const view = await mountAlreadyHeld(api);
    await tick(10_000);
    expect(view.result.current.secondsLeft).toBeLessThan(900);

    await act(async () => { await view.result.current.keepAlive(); });

    expect(view.result.current.secondsLeft).toBe(900);
  });

  it('is null when the design is not ours', async () => {
    const api = stubApi(THEIRS);
    const view = renderHook(() => useCheckout({ api, ref: REF }));
    await tick(0);

    expect(view.result.current.secondsLeft).toBeNull();
  });
});

describe('losing it', () => {
  it('notices when a poll says someone else has it', async () => {
    const api = stubApi(MINE);
    const view = await mountAlreadyHeld(api);
    api.set(THEIRS);

    await tick(15_000);

    expect(view.result.current.held).toBe(false);
    expect(view.result.current.lostUnexpectedly).toBe(true);
  });

  it('notices a 423 from a refresh', async () => {
    const api = stubApi();
    const view = await mountHeld(api);
    await fire('pointerdown');
    // A 423 means somebody else has it now, so the server must say so too -- otherwise the
    // free-design poll immediately hands it back and the test is fiction.
    api.beatCheckout.mockRejectedValue(new ApiError('gone', 423));
    api.set(THEIRS);

    await tick(15_000);

    expect(view.result.current.held).toBe(false);
    expect(view.result.current.lostUnexpectedly).toBe(true);
  });

  it('keeps the hold on a transient failure rather than flapping to read-only', async () => {
    // One dropped request must not drop a live editor out of the design.
    const api = stubApi();
    const view = await mountHeld(api);
    await fire('pointerdown');
    api.beatCheckout.mockRejectedValue(new ApiError('gateway', 502));

    await tick(15_000);

    expect(view.result.current.held).toBe(true);
    expect(view.result.current.lostUnexpectedly).toBe(false);
  });

  it('says nothing when the user released it on purpose', async () => {
    const api = stubApi();
    const view = await mountHeld(api);

    await act(async () => { await view.result.current.release(); });

    expect(view.result.current.held).toBe(false);
    expect(view.result.current.lostUnexpectedly).toBe(false);
  });

  it('clears the notice once the design is taken back', async () => {
    const api = stubApi();
    const view = await mountHeld(api);
    await act(() => { view.result.current.lost(); });
    expect(view.result.current.lostUnexpectedly).toBe(true);

    await act(async () => { await view.result.current.take(); });

    expect(view.result.current.lostUnexpectedly).toBe(false);
    expect(view.result.current.held).toBe(true);
  });
});

describe('on a developer\'s own machine', () => {
  // There is nobody to hand the design to, so every rule that frees it for a
  // colleague is friction: the user reported being locked out of their own
  // diagram every 30 s and having to press Take to keep working. `local` is
  // the option; on a real page it defaults from the hostname.

  it('takes the design on open', async () => {
    const api = stubApi();
    const view = renderHook(() => useCheckout({ api, ref: REF, local: true }));
    await tick(0);
    expect(api.takeCheckout).toHaveBeenCalledTimes(1);
    expect(view.result.current.held).toBe(true);
  });

  it('deployed, opening never takes it', async () => {
    // The default, and the reason the default is `false` rather than
    // `isLocalHost(location.hostname)`: jsdom and every E2E browser run on
    // localhost, so a hostname default put suites that test the deployed
    // model into local mode instead.
    const api = stubApi();
    const view = renderHook(() => useCheckout({ api, ref: REF }));
    await tick(0);
    expect(api.takeCheckout).not.toHaveBeenCalled();
    expect(view.result.current.held).toBe(false);
  });

  it('beats every tick with nobody touching anything', async () => {
    const api = stubApi(MINE);
    await mountAlreadyHeld(api, { local: true });
    api.beatCheckout.mockClear();

    await tick(20 * 60_000);

    expect(api.beatCheckout).toHaveBeenCalled();
  });

  it('takes it straight back when it lapses, and says nothing', async () => {
    const api = stubApi();
    const view = renderHook(() => useCheckout({ api, ref: REF, local: true }));
    await tick(0);
    expect(view.result.current.held).toBe(true);

    api.set(FREE); // the server let it go
    await tick(15_000);

    expect(api.takeCheckout).toHaveBeenCalledTimes(2);
    expect(view.result.current.held).toBe(true);
    expect(view.result.current.lostUnexpectedly).toBe(false);
  });

  it('takes it back after a 423 too', async () => {
    const api = stubApi();
    const view = renderHook(() => useCheckout({ api, ref: REF, local: true }));
    await tick(0);
    api.beatCheckout.mockImplementationOnce(async () => { throw new ApiError('lapsed', 423); });

    await tick(15_000);

    expect(api.takeCheckout).toHaveBeenCalledTimes(2);
    expect(view.result.current.held).toBe(true);
    expect(view.result.current.lostUnexpectedly).toBe(false);
  });
});
