import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import { nearestIndex } from './search';
import type { TimeState, TimeStore } from './store';

/**
 * React access to the TimeStore. Read narrowly: a component that only needs the cursor index
 * should not re-render when playback toggles, and a chart should not re-render at all (it
 * subscribes to the store directly and moves its cursor layer itself).
 */

export const TimeContext = createContext<TimeStore | null>(null);

/** The page's TimeStore. Throws outside a `TimeProvider`: a cursor with no store is a wiring bug. */
export function useTimeStore(): TimeStore {
  const store = useContext(TimeContext);
  if (!store) throw new Error('useTimeStore: no <TimeProvider> above this component');
  return store;
}

/** The store if there is one (a chart drawn outside a Burn page has no cursor). */
export function useOptionalTimeStore(): TimeStore | null {
  return useContext(TimeContext);
}

/**
 * A slice of the time state. Re-renders only when `isEqual(previous, next)` is false. Keep the
 * selector cheap and return a primitive or a reference the state already holds.
 */
export function useTime<T>(selector: (s: TimeState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useTimeStore();
  return useTimeOf(store, selector, isEqual);
}

/**
 * A `getSnapshot` for `useSyncExternalStore` that selects a slice and keeps the previous slice
 * when the new one is equal, so React sees no change and does not render. Exposed for tests.
 */
export function selectSnapshot<T>(store: TimeStore, selector: (s: TimeState) => T, isEqual: (a: T, b: T) => boolean = Object.is): () => T {
  const memo: { state: TimeState | null; value: T | undefined; has: boolean } = { state: null, value: undefined, has: false };
  return (): T => {
    const s = store.get();
    if (memo.has && s === memo.state) return memo.value as T;
    const v = selector(s);
    memo.state = s;
    if (!(memo.has && isEqual(memo.value as T, v))) {
      memo.value = v;
      memo.has = true;
    }
    return memo.value as T;
  };
}

/** `useTime` against an explicit store (or none: then `fallback`). */
export function useTimeOf<T>(store: TimeStore | null, selector: (s: TimeState) => T, isEqual: (a: T, b: T) => boolean = Object.is, fallback?: T): T {
  const getSnapshot = useMemo(
    () => (store ? selectSnapshot(store, selector, isEqual) : () => fallback as T),
    [store, selector, isEqual, fallback],
  );
  const subscribe = useMemo(() => (store ? store.subscribe : () => () => {}), [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const indexOf = (s: TimeState) => nearestIndex(s.series, s.t);

/** Index into the store's series nearest the cursor; -1 before a run is loaded. */
export function useCursorIndex(): number {
  return useTime(indexOf);
}

/** The cursor time [s]. Re-renders every frame while scrubbing; prefer `useCursorIndex`. */
export function useCursorT(): number {
  return useTime(cursorT);
}

const cursorT = (s: TimeState) => s.t;
