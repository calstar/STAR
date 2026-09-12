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
 *   While held, a heartbeat re-takes it well inside the server's lock_ttl.
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
};

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
  /** How often to re-stamp the checkout while we hold it (must beat the server's lock_ttl). */
  heartbeatMs?: number;
}

export function useCheckout<T>({
  api,
  ref,
  reload,
  pollMs = 10_000,
  heartbeatMs = 60_000,
}: UseCheckoutOptions<T>): Checkout {
  const [state, setState] = useState<CheckoutState>(FREE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [key]);

  // Keep it alive while we hold it. The server treats a checkout with no
  // heartbeat inside lock_ttl (5 min) as free, and autosave only writes when the
  // design CHANGED -- so a long read, or a long optimizer run, let the token
  // lapse under the holder and the next write came back 423 ("your checkout
  // has lapsed"). Re-taking is the heartbeat: for the holder it is idempotent
  // and re-stamps lockHeartbeat. A 423 here means somebody took it in a gap;
  // drop to read-only at once instead of finding out on the next save.
  useEffect(() => {
    if (!ref || !state.lockedByMe) return;
    let cancelled = false;
    const beat = () => {
      const r = refRef.current;
      if (!r) return;
      api
        .takeCheckout(r)
        .then((s) => !cancelled && setState(s))
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof ApiError && e.status === 423) {
            setState((prev) => ({ ...prev, lockedByMe: false }));
            api.getCheckout(r).then((s) => !cancelled && setState(s)).catch(() => {});
          }
          /* anything else is transient (network blip); the next beat retries */
        });
    };
    const id = setInterval(beat, heartbeatMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, key, state.lockedByMe, heartbeatMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll only while we do NOT hold it. A chip reading "taken" after the holder
  // has released is worse than no chip; this is what makes Take light up on its
  // own. While we hold it the heartbeat above is what keeps the state honest.
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

  // Give it back when the tab goes away, so a colleague is not left waiting out
  // the inactivity timeout for a design nobody has open. Only on pagehide: this
  // used to fire on visibilitychange too, which released the checkout the moment
  // the user looked at another tab -- mid-optimization, that turned the run's
  // result write into "Take Design 1 before saving". A hidden tab still holds
  // and heartbeats; a closed one lapses after lock_ttl.
  useEffect(() => {
    const drop = () => {
      const r = refRef.current;
      if (r && heldRef.current) api.releaseCheckoutOnUnload(r);
    };
    window.addEventListener('pagehide', drop);
    return () => {
      window.removeEventListener('pagehide', drop);
    };
  }, [api]);

  const take = useCallback(async () => {
    const r = refRef.current;
    if (!r) return;
    setBusy(true);
    setError(null);
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
  }, []);

  return {
    holder: state.lockedBy,
    holderName: state.lockedByName ?? state.lockedBy,
    held: state.lockedByMe,
    busy,
    error,
    take,
    release,
    lost,
  };
}
