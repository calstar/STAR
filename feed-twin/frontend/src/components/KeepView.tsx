/**
 * The P&ID keeps where it was looked at.
 *
 * pid-designer's canvas fits the whole sheet whenever it mounts, which is
 * right for a drawing seen for the first time and wrong for one somebody
 * zoomed into, went to the Console to press Fire, and came back to: the zoom
 * was gone mid-burn. Rendered inside the canvas (a child of its React Flow),
 * this remembers the viewport per drawing and page and puts it back after the
 * canvas's own fit -- and on a first visit fits tighter than the canvas does,
 * so the numbers on a wide sheet are large enough to read.
 *
 * Kept for the tab (module state) and for a reload (sessionStorage). A
 * per-viewer convenience: nothing else depends on it, and an empty store is
 * the first-visit fit.
 */

import { useEffect, useRef } from 'react';
import { useNodesInitialized, useOnViewportChange, useReactFlow, type Viewport } from '@xyflow/react';

const STORE = 'feedtwin.pid.view';

/** Margin round the sheet on a first visit, as a fraction of the canvas:
 *  tighter than React Flow's 0.1, which left a wide sheet's readings small;
 *  not much tighter, because a symbol's name hangs below its box and the
 *  fit measures the boxes. */
export const FIRST_FIT_PADDING = 0.06;

const views = new Map<string, Viewport>();

function stored(sheet: string): Viewport | undefined {
  if (views.has(sheet)) return views.get(sheet);
  try {
    const all = JSON.parse(window.sessionStorage.getItem(STORE) ?? '{}') as Record<string, Viewport>;
    const v = all[sheet];
    return v && [v.x, v.y, v.zoom].every(Number.isFinite) ? v : undefined;
  } catch {
    return undefined;
  }
}

function store(sheet: string, v: Viewport) {
  views.set(sheet, v);
  try {
    const all = JSON.parse(window.sessionStorage.getItem(STORE) ?? '{}') as Record<string, Viewport>;
    all[sheet] = { x: v.x, y: v.y, zoom: v.zoom };
    window.sessionStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    // Storage can be unavailable; the view still holds for this tab.
  }
}

/** `sheet` names what is shown: the drawing and its page. */
export function KeepView({ sheet }: { sheet: string }) {
  const { fitView, setViewport } = useReactFlow();
  const ready = useNodesInitialized();
  const placed = useRef<string | null>(null);

  useEffect(() => {
    if (!ready || placed.current === sheet) return;
    const saved = stored(sheet);
    // The canvas queued its own fit on this sheet a moment ago; this one is
    // queued behind it and resolves once the sheet is fitted, so the saved
    // view is put back after the canvas's fit rather than under it.
    void fitView({ padding: FIRST_FIT_PADDING }).then(() => {
      if (saved) void setViewport(saved);
      placed.current = sheet;
    });
  }, [ready, sheet, fitView, setViewport]);

  useOnViewportChange({
    onEnd: (v) => {
      // Only a view on this sheet, once it is placed: the fit that runs
      // while the page changes is not where anybody looked.
      if (placed.current === sheet) store(sheet, v);
    },
  });
  return null;
}
