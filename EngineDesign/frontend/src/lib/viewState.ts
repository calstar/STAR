/**
 * How the app looks to you: which tab, what is collapsed, what is shown.
 *
 * Deliberately NOT part of the design. A design is shared and versioned, so
 * putting view state in it means collapsing a card marks the design dirty,
 * needs the checkout, creates a history entry, and shows up as an edit in a
 * colleague's timeline. That is the mistake commit 8b050885 undid for these
 * tools, and `lib/designState.ts` is the other side of the same line: authored
 * engineering values go in the design, appearance goes here.
 *
 * Per browser, per person. It is not synced anywhere and nothing depends on it
 * being present -- every read falls back to the caller's initial value.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const KEY = 'engine-design.view.v1';

type Store = Record<string, unknown>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Private mode, disabled storage, or corrupt JSON. The app works fine
    // without it; it just forgets.
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota or disabled storage -- losing a tab preference is not worth a throw */
  }
}

/**
 * `useState`, remembered per browser under one namespaced key.
 *
 * Use it for anything purely visual. Anything the user *authored* belongs in
 * `useDesignSlice` instead, or it will not reach the people they share with.
 */
export function useViewState<T>(name: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = readStore()[name];
    return stored === undefined ? initial : (stored as T);
  });

  // Written on change rather than on every render, and read-modify-write so two
  // hooks sharing the store do not clobber each other.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    writeStore({ ...readStore(), [name]: value });
  }, [name, value]);

  const set = useCallback((v: T) => setValue(v), []);
  return [value, set];
}
