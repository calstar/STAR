import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { API_BASE } from '../../../api/client';
import { useOptionalTimeStore, useTimeOf } from '../time/hooks';
import { nearestIndex } from '../time/search';
import type { TimeState } from '../time/store';
import type { ThemeName } from './colormap';
import type { DrawingDocument } from './drawing';

/** The Layer X root's theme, followed when it changes (the colormap window depends on it). */
export function useLxTheme(ref: RefObject<Element | null>): ThemeName {
  const [theme, setTheme] = useState<ThemeName>('dark');
  useLayoutEffect(() => {
    const root = ref.current?.closest('.lx');
    if (!root) return;
    const read = () => setTheme(root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
    read();
    const mo = new MutationObserver(read);
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [ref]);
  return theme;
}

/** An element's content width [px], followed on resize; `initial` until measured. */
export function useWidth(ref: RefObject<HTMLElement | null>, initial = 0): number {
  const [w, setW] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(Math.round(el.clientWidth));
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setW(Math.round(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const indexOf = (s: TimeState) => nearestIndex(s.series, s.t);

/**
 * The cursor's sample index, re-rendering only when it changes sample. Outside a TimeProvider (a
 * render test) it is `fallback`.
 */
export function useCursorIndexOr(fallback: number): number {
  const store = useOptionalTimeStore();
  return useTimeOf(store, indexOf, Object.is, fallback);
}

// ------------------------------------------------------------------ the drawing document

const docs = new Map<string, Promise<DrawingDocument>>();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET /api/layerx/drawings/{id}/document, kept for the session (a drawing's id is its content hash,
 * so it never changes under the same id). Retries a few times: the API restarts while the backend
 * is edited, and a fetch in that window fails.
 */
export function fetchDrawing(id: string, attempts = 4): Promise<DrawingDocument> {
  const hit = docs.get(id);
  if (hit) return hit;
  const p = (async () => {
    let last: unknown = null;
    for (let k = 0; k < attempts; k++) {
      try {
        const r = await fetch(`${API_BASE}/layerx/drawings/${encodeURIComponent(id)}/document`);
        if (r.ok) return (await r.json()) as DrawingDocument;
        // A drawing that is not there will not appear by asking again.
        if (r.status === 404) throw new Error(`Drawing ${id} is not in this backend`);
        last = new Error(`HTTP ${r.status}`);
      } catch (e) {
        last = e;
        if (e instanceof Error && e.message.includes('not in this backend')) break;
      }
      await wait(1200 * (k + 1));
    }
    throw last instanceof Error ? last : new Error('Could not load the drawing');
  })();
  docs.set(id, p);
  p.catch(() => docs.delete(id));
  return p;
}

export type Loaded<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'error'; error: string };

/** The drawing document for `id`, or `preset` when given (tests, the harness). */
export function useDrawingDocument(id: string, preset?: DrawingDocument | null): Loaded<DrawingDocument> {
  const [got, setGot] = useState<{ id: string; v: Loaded<DrawingDocument> } | null>(null);
  useEffect(() => {
    if (preset || !id) return;
    let live = true;
    fetchDrawing(id).then(
      (value) => { if (live) setGot({ id, v: { state: 'ready', value } }); },
      (e: unknown) => { if (live) setGot({ id, v: { state: 'error', error: e instanceof Error ? e.message : String(e) } }); },
    );
    return () => { live = false; };
  }, [id, preset]);
  if (preset) return { state: 'ready', value: preset };
  if (!id) return { state: 'error', error: 'No drawing' };
  return got && got.id === id ? got.v : { state: 'loading' };
}
