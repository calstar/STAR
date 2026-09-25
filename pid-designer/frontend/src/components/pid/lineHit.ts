import type { XYPosition } from '@xyflow/react';
import { nearestOnPolyline, pathPoints, simplifyPoints } from './route';
import type { Pt } from './route';

/** One line as it is actually drawn: its id, and its path data. */
export interface DrawnLine {
  id: string;
  d: string;
}

/**
 * The pipes on screen, read back from what was rendered.
 *
 * Read rather than recomputed: the edge owns its routing, including a crossbar
 * somebody has dragged, and a second copy of that geometry would be one more
 * thing to keep in step. Hidden pages are not rendered, so this is scoped to
 * the page for free.
 */
export function drawnLines(): DrawnLine[] {
  const out: DrawnLine[] = [];
  for (const el of document.querySelectorAll('.react-flow__edge[data-id]')) {
    const d = el.querySelector('.react-flow__edge-path')?.getAttribute('d');
    if (d) out.push({ id: el.getAttribute('data-id')!, d });
  }
  return out;
}

/**
 * A drawn path's corners, simplified and without its hops, remembered by the
 * path itself: a line that has not moved draws the same `d` again, so asking
 * as the pointer moves -- which the hover dot and a press both do, over every
 * line on the page -- costs a lookup per line, not a parse. The table is
 * dropped whole when it grows past what one page could ever hold, rather than
 * kept in order, since every entry is a pure function of its key.
 */
const parsed = new Map<string, Pt[]>();
const PARSED_MAX = 8192;

export function cornersOf(d: string): Pt[] {
  let pts = parsed.get(d);
  if (!pts) {
    if (parsed.size >= PARSED_MAX) parsed.clear();
    pts = simplifyPoints(pathPoints(d));
    parsed.set(d, pts);
  }
  return pts;
}

/**
 * The lines on the page now, as their corners (`cornersOf`). Empty where
 * there is no page to read, so a caller with no DOM falls back on its own.
 */
export function pageLines(): { id: string; points: Pt[] }[] {
  if (typeof document === 'undefined') return [];
  return drawnLines().map(l => ({ id: l.id, points: cornersOf(l.d) }));
}

/** The page's own element for a line, found by id -- compared, never built into a selector, since an id may hold anything. */
export function lineElement(id: string): Element | null {
  if (typeof document === 'undefined') return null;
  for (const el of document.querySelectorAll('.react-flow__edge[data-id]')) if (el.getAttribute('data-id') === id) return el;
  return null;
}

/** A click, a double-click or a right-click, as React hands one over. */
export interface MouseLike {
  type: string;
  clientX: number; clientY: number;
  button?: number; buttons?: number; detail?: number;
  altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean;
  stopPropagation(): void;
  preventDefault(): void;
}

let handing = 0;

/**
 * Hands a click, a double-click or a right-click on to the line `id`: the
 * same event, sent to that line's own element, so React Flow selects the
 * line and the designer configures, paints or colours it exactly as if it
 * had landed there -- and kept from whatever it did land on, which would
 * otherwise have been picked, and then deleted by the Delete that followed.
 * False, with the event left alone, where the line is not on the page.
 *
 * This is how a press given to the line nearest the pointer (`lineSourceAt`)
 * is followed by its click: presses are judged by distance, but clicks go
 * wherever the browser sends them, which is the element on top -- another
 * line's band, or a tee's halo.
 */
export function handToLine(id: string, e: MouseLike): boolean {
  const el = lineElement(id);
  if (!el) return false;
  e.stopPropagation();
  e.preventDefault();
  const { clientX, clientY, button, buttons, detail, altKey, ctrlKey, metaKey, shiftKey } = e;
  handing++;
  try {
    el.dispatchEvent(new MouseEvent(e.type, {
      bubbles: true, cancelable: true, clientX, clientY, button, buttons, detail, altKey, ctrlKey, metaKey, shiftKey,
    }));
  } finally { handing--; }
  return true;
}

/**
 * Whether the event being handled is one `handToLine` sent. The line it was
 * sent to keeps it, and does not judge again who owns it: the judge that sent
 * it may have left lines out that the line would count -- a tee leaves out
 * its own, which meet at its dot -- and asked again it could pass the click
 * to one of those.
 */
export const handedOn = () => handing > 0;

/** Where on a line a point landed. */
export interface LineHit {
  id: string;
  /** The point on the pipe itself, not the pointer. */
  at: XYPosition;
  /** Which way the pipe runs there. */
  dir: Pt;
  /** How far along the drawn run, as a fraction. */
  t: number;
  /**
   * The drawn run's corners, and only its corners: simplified, and without
   * the hops. A hop is drawn into a line's own path, so the `d` read back
   * off the page has a point where each hop starts -- five pixels from a
   * crossing, in the middle of a straight run. Kept, that point came back as
   * a corner: a valve dropped where its line hopped another stored it on its
   * halves, and later drew a phantom jog, and a diagonal, beside a line it
   * has nothing to do with.
   */
  points: Pt[];
}

/**
 * The line under a point, and where on it.
 *
 * Measured against the pipe **as drawn**. The graph-level hit test in
 * `attach.ts` measures against the straight line between two component
 * centres, which is the right cheap answer for "which line is this" and the
 * wrong one for "is this on the pipe": a run is drawn orthogonally, so on an
 * L-shaped line the two disagree by the whole depth of the bend. Dropping
 * there either missed a pipe the pointer was sitting on, or put a junction
 * forty pixels from where somebody let go.
 */
export function lineAt(
  lines: DrawnLine[],
  at: XYPosition,
  tolerance = 14,
  except?: string,
): LineHit | null {
  let best: LineHit | null = null;
  let bestDist = tolerance;
  for (const line of lines) {
    if (line.id === except) continue;
    const points = simplifyPoints(pathPoints(line.d));
    const near = nearestOnPolyline(points, at);
    if (!near) continue;
    if (near.dist < bestDist) {
      bestDist = near.dist;
      best = { id: line.id, at: near.point, dir: near.dir, t: near.t, points };
    }
  }
  return best;
}
