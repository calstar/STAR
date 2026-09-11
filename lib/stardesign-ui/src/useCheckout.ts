/**
 * Client half of design checkouts: who holds the write token, and how you get
 * it. The server half is `lib/stardesign`'s `documents.py`.
 *
 * The model, which the shape of this hook follows:
 *
 * - **Opening a design never takes it.** Viewing must not block a colleague, so
 *   there is no acquire-on-mount here. The user presses Take.
 * - **Without the token the editor is read-only.** `held` is what an app gates
 *   its inputs on. Greyed fields, not merely a refused save -- so there is no
 *   state where someone believes they have it and does not.
 * - **It lapses** after inactivity server-side, and is released on tab close.
 *
 * Two things in here exist to prevent data loss rather than to be tidy:
 *
 * 1. `take()` reloads the design before handing back control. Sitting in
 *    read-only while the holder saved leaves a stale view, and editing from
 *    there would overwrite their work on the very first autosave.
 * 2. `lost()` exists because a save can come back 423 (the token lapsed and
 *    someone else took it). The app must drop to read-only rather than keep
 *    retrying into a void.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckoutState, DesignApi, DocRef } from './api';
import { ApiError, keyOf } from './api';

const FREE: CheckoutState = {
  lockedBy: null,
  lockedByName: null,
  lockedByMe: false,
  lockExpiresAt: null,
  lockTtlSeconds: null,
};

/** Interaction that counts as "still working on this". Deliberately coarse and
 *  passive: it only stamps a ref, so it costs nothing on a hot canvas. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

export interface Checkout {
  /** Email of whoever holds it, or null when free. */
  holder: string | null;
  /** Display name for the holder, falling back to the email. */
  holderName: string | null;
  /** Do I hold it? The gate an app puts its inputs behind. */
  held: boolean;
  /** A take or release is in flight. */
  busy: boolean;
  /** Why the last take failed, for showing next to the button. */
  error: string | null;
  take: () => Promise<void>;
  release: () => Promise<void>;
  /** Call when a write comes back 423 -- the token is gone. */
  lost: () => void;
  /** Refresh the hold now. The "Keep editing" button; also safe to call on
   *  any deliberate user action an app wants to count. */
  keepAlive: () => Promise<void>;
  /** When the hold lapses, or null. Drives the countdown in the bar. */
  expiresAt: string | null;
  /** Whole seconds until it lapses, or null when we do not hold it. */
  secondsLeft: number | null;
  /**
   * We held it and no longer do, and we did not choose that. The app shows a
   * dialog on this -- it is the difference between losing a design quietly and
   * being told. Cleared by `acknowledgeLost`.
   */
  lostUnexpectedly: boolean;
  acknowledgeLost: () => void;
}

export interface UseCheckoutOptions<T> {
  api: DesignApi<T>;
  /** The open design, or null when none is. */
  ref: DocRef | null;
  /**
   * Reload the design's content. Awaited inside `take()` before `held` flips,
   * so an app is never editable while showing a stale view.
   */
  reload?: () => Promise<void> | void;
  /** How often to re-check while somebody else holds it. */
  pollMs?: number;
  /** How often to beat/re-check while we DO hold it. */
  heldPollMs?: number;
  /**
   * Stop beating once interaction is this old, so a design left open on an
   * unattended machine still frees itself. Activity inside this window keeps
   * the hold indefinitely; that is the whole point.
   */
  idleCapMs?: number;
}

export function useCheckout<T>({
  api,
  ref,
  reload,
  pollMs = 10_000,
  heldPollMs = 15_000,
  idleCapMs = 15 * 60_000,
}: UseCheckoutOptions<T>): Checkout {
  const [state, setState] = useState<CheckoutState>(FREE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lostUnexpectedly, setLostUnexpectedly] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const key = ref ? keyOf(ref) : null;
  // Read inside callbacks and the unload handler, so neither needs `ref` in a
  // dependency array and neither goes stale.
  const refRef = useRef(ref);
  refRef.current = ref;
  const heldRef = useRef(false);
  heldRef.current = state.lockedByMe;

  // Switching designs drops any claim we were showing: the new one is somebody
  // else's question entirely, and showing the old answer would be a lie.
  useEffect(() => {
    setState(FREE);
    setError(null);
    setLostUnexpectedly(false);
  }, [key]);

  // Last interaction of any kind. A ref, not state: these fire continuously
  // while dragging a node and must not re-render anything.
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    const mark = () => {
      lastActivityRef.current = Date.now();
    };
    for (const e of ACTIVITY_EVENTS)
      window.addEventListener(e, mark, { passive: true });
    return () => {
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, mark);
    };
  }, []);

  // While we hold it, beat on recent activity and re-check otherwise.
  //
  // Both halves matter. The beat is what fixes "it kicked me out while I was
  // working": before this, the ONLY thing that refreshed a hold was a
  // successful autosave, so panning, measuring, reading a result or thinking
  // all counted as idle. The re-check is what fixes "with no notice": this
  // hook used to stop polling the moment it held the token, on the reasoning
  // that our own saves keep it -- so when a hold did lapse the canvas stayed
  // editable and the user found out only when a save came back 423, having
  // typed into a void in the meantime.
  useEffect(() => {
    if (!ref || !state.lockedByMe) return;
    let cancelled = false;
    const tick = () => {
      const active = Date.now() - lastActivityRef.current < idleCapMs;
      const call = active ? api.beatCheckout(ref) : api.getCheckout(ref);
      call
        .then((s) => {
          if (cancelled) return;
          setState(s);
          if (!s.lockedByMe) setLostUnexpectedly(true);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          // 423 is the definitive answer: it is gone and someone else may have
          // it. Anything else is transient -- keep what we last knew rather
          // than flapping a live editor to read-only on one dropped request.
          if (e instanceof ApiError && e.status === 423) {
            setState((prev) => ({ ...prev, lockedByMe: false }));
            setLostUnexpectedly(true);
          }
        });
    };
    const id = setInterval(tick, heldPollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, ref, state.lockedByMe, heldPollMs, idleCapMs]);

  // A 1 Hz clock, only while we hold it, so the bar can count down.
  useEffect(() => {
    if (!state.lockedByMe || !state.lockExpiresAt) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.lockedByMe, state.lockExpiresAt]);

  // Poll only while we do NOT hold it. A chip reading "taken" after the holder
  // has released is worse than no chip; this is what makes Take light up on its
  // own. Once we hold it there is nothing to learn -- our own saves keep it.
  useEffect(() => {
    if (!ref || state.lockedByMe) return;
    let cancelled = false;
    const tick = () => {
      api
        .getCheckout(ref)
        .then((s) => !cancelled && setState(s))
        .catch(() => {
          /* transient: keep what we last knew rather than flapping to free */
        });
    };
    tick();
    const id = setInterval(tick, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, key, state.lockedByMe, pollMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Give it back when the tab actually goes away, so a colleague is not left
  // waiting out the inactivity timeout for a design nobody has open.
  //
  // `pagehide` only -- deliberately NOT `visibilitychange`. That fires whenever
  // the tab merely stops being visible: switching to another tab, minimising
  // the window, or closing a laptop lid. Releasing on those meant glancing at
  // something else for a few seconds silently cost you the checkout, and taking
  // it back reloads the design. The inactivity timeout covers the case this was
  // reaching for.
  useEffect(() => {
    const drop = () => {
      const r = refRef.current;
      if (r && heldRef.current) api.releaseCheckoutOnUnload(r);
    };
    window.addEventListener('pagehide', drop);
    return () => window.removeEventListener('pagehide', drop);
  }, [api]);

  const take = useCallback(async () => {
    const r = refRef.current;
    if (!r) return;
    setBusy(true);
    setError(null);
    setLostUnexpectedly(false);
    lastActivityRef.current = Date.now();
    try {
      const s = await api.takeCheckout(r);
      // Reload before going editable. This is the ordering that matters: the
      // view may be stale, and editing a stale view would overwrite whoever
      // just finished.
      await reload?.();
      setState(s);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Could not take it. Try again in a moment.',
      );
      // Refresh so the chip shows who actually has it, not a guess.
      api.getCheckout(r).then(setState).catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [api, reload]);

  const release = useCallback(async () => {
    const r = refRef.current;
    if (!r) return;
    setBusy(true);
    try {
      setState(await api.releaseCheckout(r));
    } catch {
      setState(FREE); // best effort; the timeout frees it regardless
    } finally {
      setBusy(false);
    }
  }, [api]);

  const lost = useCallback(() => {
    setState((s) => ({ ...s, lockedByMe: false }));
    setLostUnexpectedly(true);
  }, []);

  const acknowledgeLost = useCallback(() => setLostUnexpectedly(false), []);

  const keepAlive = useCallback(async () => {
    const r = refRef.current;
    if (!r || !heldRef.current) return;
    lastActivityRef.current = Date.now();
    try {
      setState(await api.beatCheckout(r));
    } catch (e) {
      if (e instanceof ApiError && e.status === 423) {
        setState((prev) => ({ ...prev, lockedByMe: false }));
        setLostUnexpectedly(true);
      }
      // anything else is transient; the interval will try again
    }
  }, [api]);

  // Only meaningful while we hold it: the bar shows a countdown, not a clock.
  const secondsLeft =
    state.lockedByMe && state.lockExpiresAt
      ? Math.max(0, Math.round((Date.parse(state.lockExpiresAt) - now) / 1000))
      : null;

  return {
    holder: state.lockedBy,
    holderName: state.lockedByName ?? state.lockedBy,
    held: state.lockedByMe,
    busy,
    error,
    take,
    release,
    lost,
    keepAlive,
    expiresAt: state.lockExpiresAt,
    secondsLeft: secondsLeft !== null && Number.isFinite(secondsLeft) ? secondsLeft : null,
    lostUnexpectedly,
    acknowledgeLost,
  };
}
