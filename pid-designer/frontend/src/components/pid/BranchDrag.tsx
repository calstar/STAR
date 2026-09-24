import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ViewportPortal, useReactFlow } from '@xyflow/react';
import { nearestOnPolyline } from './route';
import type { Pt } from './route';
import { lineUnder, resolveDrop } from './drop';
import type { DrawnPoints, DropScene, Under } from './drop';
import { J_HALF } from './junctions';
import { pageLines } from './lineHit';
import { previewer, pullOf } from './preview';
import type { PreviewShape } from './preview';

/**
 * Drawing a line out of a line.
 *
 * The order of operations used to be backwards: to tee off a run and go
 * somewhere, you first placed the thing you were going to, then dragged from
 * it back to the run. You could not start a line *from* a line, and you
 * could not start one from a tee.
 *
 * This is the rubber band for that. Press on a line (or on a tee's ring) and
 * pull: a preview follows the pointer, and letting go on a port, a
 * component, another line or empty canvas is what the drop handler in the
 * designer turns into a tee and a line. React Flow's own connection drag is
 * kept for ports -- it already lands on lines -- so this only exists for the
 * two places a drag could not start from before.
 *
 * The preview is the drop itself, worked out as the pointer moves: the
 * designer lends the lookups its drop handlers use (`DropLookups`), each
 * frame asks `resolveDrop` what letting go there would make, and the preview
 * draws that (preview.ts) -- the route, the tee, the port it joins, or, where
 * letting go makes nothing, the bare pull faded out. Once a frame, however
 * fast the pointer reports, since resolving is the dearest thing a pull does.
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
  /** What letting go here draws, as resolved at the last frame; unset until then, or with no designer to ask. */
  preview?: PreviewShape | null;
}

/**
 * What the designer lends the gestures inside it: the drawing a drop is
 * resolved against, what is under the pointer, and the line whose end is
 * being carried to somewhere else, when one is. The same things its drop
 * handlers ask, so a preview shows what letting go will make.
 */
export interface DropLookups {
  scene: () => DropScene;
  under: (client: Pt, at: Pt, scene: DropScene, near?: { nodeId: string; id?: string | null } | null) => Under;
  carrying: () => string | null;
}

interface BranchApi {
  begin: (source: BranchSource, e: { clientX: number; clientY: number }) => void;
  active: boolean;
  /** The designer's lookups, or null where there is no designer to ask. */
  drop: DropLookups | null;
}

const ApiContext = createContext<BranchApi>({ begin: () => {}, active: false, drop: null });
const StateContext = createContext<BranchState | null>(null);

export const useBranchDrag = () => useContext(ApiContext);

/** How far the pointer has to travel, in screen pixels, before a press becomes a pull. */
const THRESHOLD = 6;

/**
 * The drawn line nearest `at`, as the place a pull out of it would start, and
 * how far the pointer is from it -- or null with none in reach.
 *
 * This is how a press is given to a line: by distance, the rule a drop is
 * judged by (`lineUnder`, over the lines as the page draws them), and not by
 * which line's element happens to be on top. Every line is its own element,
 * stacked in the order the lines were made, so wherever two ran close the
 * newer took presses aimed at the older's own stroke -- the tee went on the
 * other pipe -- while a drop at the same spot went to the older. `skip`
 * leaves lines out by id: a tee's own lines, which meet at its dot.
 */
export function lineSourceAt(
  at: Pt, zoom: number, skip?: (id: string) => boolean, lines: readonly DrawnPoints[] = pageLines(),
): { source: Extract<BranchSource, { kind: 'line' }>; dist: number } | null {
  const near = lineUnder(skip ? lines.filter(l => !skip(l.id)) : lines, at, zoom);
  const on = near && nearestOnPolyline(near.points, at);
  return near && on
    ? { source: { kind: 'line', edgeId: near.id, at: on.point, dir: on.dir, points: near.points }, dist: on.dist }
    : null;
}

/** The next animation frame, or -- with no frames to wait for, as with no DOM -- straight away. */
export function nextFrame(f: () => void): number {
  if (typeof requestAnimationFrame !== 'function') { f(); return 0; }
  return requestAnimationFrame(() => f());
}
export function cancelFrame(id: number): void {
  if (id && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);
}

export function BranchDragProvider({ readOnly, onDrop, scene, under, carrying, children }: {
  readOnly: boolean;
  /** The pull ended: here, in flow space, and here on screen. */
  onDrop: (source: BranchSource, at: Pt, client: { x: number; y: number }) => void;
  /** The drawing as the drop handlers resolve against it. Unset, previews draw the bare pull. */
  scene?: DropLookups['scene'];
  under?: DropLookups['under'];
  carrying?: DropLookups['carrying'];
  children: ReactNode;
}) {
  const { screenToFlowPosition } = useReactFlow();
  const [state, setState] = useState<BranchState | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const stateRef = useRef<BranchState | null>(null);
  stateRef.current = state;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  // Read through a ref and handed on as one object that keeps its identity:
  // every line and every tee reads this context, and a new object whenever
  // the canvas re-rendered -- once a second for the checkout clock alone --
  // re-rendered every one of them with it.
  const given = useRef({ scene, under, carrying });
  given.current = { scene, under, carrying };
  const canResolve = !!scene && !!under;
  const drop = useMemo<DropLookups | null>(() => (canResolve ? {
    scene: () => given.current.scene!(),
    under: (client, at, sc, near) => given.current.under!(client, at, sc, near),
    carrying: () => given.current.carrying?.() ?? null,
  } : null), [canResolve]);

  const begin = useCallback((source: BranchSource, e: { clientX: number; clientY: number }) => {
    if (readOnly) return;
    startRef.current = { x: e.clientX, y: e.clientY };
    setState({ source, cursor: source.at, moved: false });
  }, [readOnly]);

  useEffect(() => {
    if (!state) return;
    let frame = 0;
    let last: { x: number; y: number } | null = null;
    // The drawing does not change while a pull is in progress, so it is read
    // once, at the first frame that resolves anything.
    let drawing: { scene: DropScene; preview: ReturnType<typeof previewer> } | null = null;
    const planned = (source: BranchSource, at: Pt, client: Pt): PreviewShape | null => {
      if (!drop) return null;
      if (!drawing) { const scene = drop.scene(); drawing = { scene, preview: previewer(scene) }; }
      const { scene, preview } = drawing;
      return preview(resolveDrop(source, at, drop.under(client, at, scene), scene), { from: source.at, to: at });
    };
    const tick = () => {
      frame = 0;
      const start = startRef.current, s = stateRef.current;
      if (!start || !s || !last) return;
      const moved = s.moved || Math.hypot(last.x - start.x, last.y - start.y) > THRESHOLD;
      const cursor = screenToFlowPosition(last, { snapToGrid: false });
      const preview = moved ? planned(s.source, cursor, last) : null;
      setState(cur => (cur ? { ...cur, cursor, moved, preview } : cur));
    };
    const onMove = (e: PointerEvent) => {
      last = { x: e.clientX, y: e.clientY };
      if (!frame) frame = nextFrame(tick);
    };
    const onUp = (e: PointerEvent) => {
      cancelFrame(frame);
      frame = 0;
      const s = stateRef.current, start = startRef.current;
      startRef.current = null;
      setState(null);
      // Measured here as well as at the last frame: a pull whose last move
      // had not been drawn yet is still a pull.
      if (!s || !start || !(s.moved || Math.hypot(e.clientX - start.x, e.clientY - start.y) > THRESHOLD)) return;
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
      onDropRef.current(s.source, at, { x: e.clientX, y: e.clientY });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      cancelFrame(frame);
      frame = 0;
      startRef.current = null;
      setState(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      cancelFrame(frame);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [!!state, screenToFlowPosition, drop]); // eslint-disable-line react-hooks/exhaustive-deps

  const moved = !!state?.moved;
  const api = useMemo<BranchApi>(() => ({ begin, active: moved, drop }), [begin, moved, drop]);
  return (
    <ApiContext.Provider value={api}>
      <StateContext.Provider value={state}>
        {children}
      </StateContext.Provider>
    </ApiContext.Provider>
  );
}

/**
 * The line a pull will draw, following the pointer. Rendered inside the React
 * Flow canvas, in flow space, so it lands where the real line will.
 */
export function BranchPreview() {
  const state = useContext(StateContext);
  if (!state?.moved) return null;
  return <ViewportPortal>{previewSvg(state)}</ViewportPortal>;
}

const INK = 'var(--color-text-secondary)';

/**
 * The preview for a state, as elements: a plain function of the state,
 * called rather than mounted, so the preview is what the state says and
 * nothing a hook kept from an earlier frame.
 */
export function previewSvg(state: BranchState) {
  const { source, cursor, preview } = state;
  const points = preview?.points ?? pullOf(source.at, cursor, source.kind === 'line' ? source.dir : undefined);
  const cancel = preview?.cancel ?? false;
  return (
    <svg
      style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 5, opacity: cancel ? 0.35 : 1 }}
      width={1} height={1}
    >
      <polyline
        points={points.map(p => `${p.x},${p.y}`).join(' ')}
        fill="none" stroke={INK} strokeWidth={2} strokeDasharray="6 4"
      />
      {previewMarks(preview ?? null, points, INK)}
    </svg>
  );
}

/**
 * The marks a preview carries: a dot where a tee goes in, a hollow one where
 * an open end is left, and a ring on the port or tee the line joins. With
 * nothing resolved, or nothing to make, a hollow dot where the pull started
 * and a small one at the pointer.
 */
export function previewMarks(preview: PreviewShape | null, points: Pt[], ink: string) {
  if (!preview || preview.cancel) {
    const from = points[0], to = points[points.length - 1];
    return [
      <circle key="from" cx={from.x} cy={from.y} r={J_HALF} fill="var(--color-bg-primary)" stroke={ink} strokeWidth={2} />,
      <circle key="to" cx={to.x} cy={to.y} r={4} fill={ink} />,
    ];
  }
  return [
    ...preview.tees.map((t, i) => (
      <circle
        key={`tee${i}`} cx={t.at.x} cy={t.at.y} r={J_HALF}
        fill={t.open ? 'var(--color-bg-primary)' : ink} stroke={ink} strokeWidth={2}
      />
    )),
    ...(preview.ring ? [
      <circle key="ring" cx={preview.ring.x} cy={preview.ring.y} r={7} fill="none" stroke={ink} strokeWidth={1.5} />,
    ] : []),
  ];
}
