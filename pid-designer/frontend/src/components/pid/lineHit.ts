import type { XYPosition } from '@xyflow/react';
import { nearestOnPath } from './BranchableEdge';

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
): { id: string; at: XYPosition } | null {
  let best: { id: string; at: XYPosition } | null = null;
  let bestDist = tolerance;
  for (const line of lines) {
    const q = nearestOnPath(line.d, at);
    const dist = Math.hypot(q.x - at.x, q.y - at.y);
    if (dist < bestDist) { bestDist = dist; best = { id: line.id, at: q }; }
  }
  return best;
}
