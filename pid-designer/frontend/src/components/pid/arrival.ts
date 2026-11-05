/**
 * Where a page is put when somebody first arrives on it.
 *
 * It used to be framed whole, whatever that cost. A stand's Rocket page is a
 * tall column -- bottle, regulators, tanks, engine -- so framed whole on a
 * 1080p screen it sat in the middle third at about two-thirds size, the tags
 * read at six pixels and the pressures printed in the tanks could not be read
 * at all. Now a page that would be framed below full size is put up at its
 * full width, never above 1:1 (the size its symbols are drawn at), from its
 * top: the press section of a stand, readable, with the rest a scroll away.
 * A page whose width is what limits it is framed whole, as before, and so is
 * one that fits at 1:1 or larger. Fit View still frames the whole page.
 */

import { useCallback } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import type { Rect, Viewport } from '@xyflow/react';

/** React Flow's own reading of a numeric fit padding: the pixels on each side (`parsePadding`). */
function side(padding: number, extent: number): number {
  return Math.floor((extent - extent / (1 + padding)) * 0.5);
}

/**
 * The view to arrive on `page` (its symbols' bounds) in a pane of `pane`, or
 * null when framing it whole -- React Flow's `fitView` with `padding` -- is
 * the answer.
 */
export function arrivalViewport(
  page: Rect,
  pane: { width: number; height: number },
  padding: number,
): Viewport | null {
  if (!(page.width > 0 && page.height > 0 && pane.width > 0 && pane.height > 0)) return null;
  const px = side(padding, pane.width), py = side(padding, pane.height);
  const across = (pane.width - 2 * px) / page.width;
  const down = (pane.height - 2 * py) / page.height;
  const whole = Math.min(across, down);
  if (whole >= 1) return null;
  const zoom = Math.min(1, across);
  if (zoom <= whole) return null; // the width is what limits it: whole it is
  return {
    zoom,
    x: pane.width / 2 - (page.x + page.width / 2) * zoom,
    y: py - page.y * zoom,
  };
}

/**
 * Put the page now on the canvas up as arriving on it does (`arrivalViewport`),
 * with `padding` as `fitView` takes it. The page is what the canvas shows: the
 * symbols it is not hiding.
 */
export function useArrive(): (padding?: number) => Promise<boolean> {
  const { fitView, setViewport, getNodes, getNodesBounds } = useReactFlow();
  const store = useStoreApi();
  return useCallback(async (padding = 0.1) => {
    const { width, height } = store.getState();
    const shown = getNodes().filter(n => !n.hidden);
    const at = shown.length ? arrivalViewport(getNodesBounds(shown), { width, height }, padding) : null;
    return at ? setViewport(at) : fitView({ padding });
  }, [fitView, setViewport, getNodes, getNodesBounds, store]);
}
