/**
 * An operator's own changes to the video grid (slot swaps, focus), kept in this browser's
 * localStorage -- a per-operator convenience, like the feed-characterization panel widths,
 * not stand state. The stand layout itself lives in config/video.json.
 */
import { useCallback, useEffect, useState } from 'react';
import type { OperatorOverride } from './layout';

const KEY = 'video.operatorLayout';

function read(): OperatorOverride | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.base === 'string' ? (v as OperatorOverride) : null;
  } catch {
    return null;
  }
}

export function useOperatorLayout(): [OperatorOverride | null, (o: OperatorOverride | null) => void] {
  const [override, setState] = useState<OperatorOverride | null>(() => (typeof window === 'undefined' ? null : read()));

  // Another window (a popped-out video view) changing it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setState(read()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const set = useCallback((o: OperatorOverride | null) => {
    setState(o);
    try {
      if (o) window.localStorage.setItem(KEY, JSON.stringify(o));
      else window.localStorage.removeItem(KEY);
    } catch { /* private mode: the change still applies to this tab */ }
  }, []);

  return [override, set];
}
