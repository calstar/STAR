import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ViewportPortal, useReactFlow } from '@xyflow/react';
import type { Pt } from './route';

/**
 * Drawing a line out of a line.
 *
 * The order of operations used to be backwards: to tee off a run and go
 * somewhere, you first placed the thing you were going to, then dragged from
 * it back to the run. You could not start a line *from* a line, and you
 * could not start one from a tee.
 *
 * This is the rubber band for that. Press on a line (or on a tee's ring) and
 * pull: a dashed preview follows the pointer, and letting go on a port, a
 * component, another line or empty canvas is what the drop handler in the
 * designer turns into a tee and a line. React Flow's own connection drag is
 * kept for ports -- it already lands on lines -- so this only exists for the
 * two places a drag could not start from before.
 *
 * Nothing happens until the pointer has moved a few pixels: a press that
 * does not move is a click, and a click on a line still selects it.
 */

export type BranchSource =
  | { kind: 'line'; edgeId: string; at: Pt; dir: Pt; points: Pt[] }
  | { kind: 'node'; nodeId: string; at: Pt };

export interface BranchState {
  source: BranchSource;
  /** Where the pointer is, in flow space. */
  cursor: Pt;
  /** Whether it has moved far enough to count as a drag rather than a click. */
  moved: boolean;
}

interface BranchApi {
  begin: (source: BranchSource, e: { clientX: number; clientY: number }) => void;
  active: boolean;
}

const ApiContext = createContext<BranchApi>({ begin: () => {}, active: false });
const StateContext = createContext<BranchState | null>(null);

export const useBranchDrag = () => useContext(ApiContext);

/** How far the pointer has to travel before a press becomes a pull. */
const THRESHOLD = 6;

export function BranchDragProvider({ readOnly, onDrop, children }: {
  readOnly: boolean;
  /** The pull ended: here, in flow space, and here on screen. */
  onDrop: (source: BranchSource, at: Pt, client: { x: number; y: number }) => void;
  children: ReactNode;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [state, setState] = useState<BranchState | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const stateRef = useRef<BranchState | null>(null);
  stateRef.current = state;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const begin = useCallback((source: BranchSource, e: { clientX: number; clientY: number }) => {
    if (readOnly) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    setState({ source, cursor: source.at, moved: false });
  }, [readOnly]);

  useEffect(() => {
    if (!state) return;
    const onMove = (e: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const moved = stateRef.current?.moved || Math.hypot(e.clientX - start.x, e.clientY - start.y) > THRESHOLD;
      const cursor = screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
      setState(s => (s ? { ...s, cursor, moved } : s));
    };
    const onUp = (e: PointerEvent) => {
      const s = stateRef.current;
      startRef.current = null;
      setState(null);
      if (!s || !s.moved) return;
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
      onDropRef.current(s.source, at, { x: e.clientX, y: e.clientY });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      startRef.current = null;
      setState(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [!!state, screenToFlowPosition]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ApiContext.Provider value={{ begin, active: !!state?.moved }}>
      <StateContext.Provider value={state}>
        {children}
      </StateContext.Provider>
    </ApiContext.Provider>
  );
}

/**
 * The dashed line that follows the pointer. Rendered inside the React Flow
 * canvas, in flow space, so it lands where the real line will.
 */
export function BranchPreview() {
  const state = useContext(StateContext);
  if (!state?.moved) return null;
  const { source, cursor } = state;
  const from = source.at;
  // Leave a run across it, the way a branch does; leave a tee sideways.
  const verticalFirst = source.kind === 'line' && Math.abs(source.dir.x) >= Math.abs(source.dir.y);
  const corner = verticalFirst ? { x: from.x, y: cursor.y } : { x: cursor.x, y: from.y };
  return (
    <ViewportPortal>
      <svg style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 5 }} width={1} height={1}>
        <polyline
          points={`${from.x},${from.y} ${corner.x},${corner.y} ${cursor.x},${cursor.y}`}
          fill="none" stroke="var(--color-text-secondary)" strokeWidth={2} strokeDasharray="6 4"
        />
        <circle cx={from.x} cy={from.y} r={5} fill="var(--color-bg-primary)" stroke="var(--color-text-secondary)" strokeWidth={2} />
        <circle cx={cursor.x} cy={cursor.y} r={4} fill="var(--color-text-secondary)" />
      </svg>
    </ViewportPortal>
  );
}
