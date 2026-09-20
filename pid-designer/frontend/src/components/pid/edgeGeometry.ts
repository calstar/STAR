import { useMemo, useSyncExternalStore } from 'react';
import type { Pt } from './route';

/**
 * Where every drawn line goes, as the lines themselves report it.
 *
 * A line needs to know where the others are to hop over them (see hops.ts),
 * and the others are React Flow edges, each deciding its own route inside its
 * own render. Rather than re-deriving all of that in one place -- and keeping
 * a second copy of the routing in step -- each edge publishes the corners it
 * drew and reads everyone else's.
 *
 * Publishing happens after render and only when the corners changed, and the
 * change notice is coalesced into a microtask. That is what stops it looping:
 * an edge that re-renders because a neighbour moved publishes nothing new,
 * so nothing wakes anyone again.
 */

const corners = new Map<string, Pt[]>();
const listeners = new Set<() => void>();
let version = 0;
let scheduled = false;

function bump() {
  version++;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const l of listeners) l();
  });
}

const sameCorners = (a: Pt[], b: Pt[]) =>
  a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y);

export function publishEdge(id: string, pts: Pt[]): void {
  const prev = corners.get(id);
  if (prev && sameCorners(prev, pts)) return;
  corners.set(id, pts);
  bump();
}

export function unpublishEdge(id: string): void {
  if (corners.delete(id)) bump();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => version;

/** Every other line's corners, refreshed whenever any line moves. */
export function useOtherEdges(id: string): Pt[][] {
  const v = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    void v;
    const out: Pt[][] = [];
    for (const [k, pts] of corners) if (k !== id) out.push(pts);
    return out;
  }, [v, id]);
}

/** For tests and the odd caller that wants the table rather than a hook. */
export const drawnCorners = () => new Map(corners);
