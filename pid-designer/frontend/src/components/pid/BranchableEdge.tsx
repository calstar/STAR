import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import { BaseEdge, useReactFlow, type EdgeProps } from '@xyflow/react';
import { splitEdgeAt } from './splitEdge';
import {
  dragSegment, jogSegment, nearestOnPolyline, pathPoints, routeOrthogonal, routeThrough, waypointsOf,
} from './route';
import type { End, Pt } from './route';
import { crossingsOf, pathWithHops } from './hops';
import { publishEdge, unpublishEdge, useOtherEdges } from './edgeGeometry';
import { useEdgeFluidColor } from './FluidContext';
import { useReadOnly } from '@stardesign-ui';
import { useTool, useToolDone } from './ToolContext';
import { useBranchDrag } from './BranchDrag';

export { nearestOnPath, faceTowards } from './route';

/**
 * A pipe: orthogonal, every segment of it movable, a tee wherever you want
 * one, and a hop wherever it crosses another.
 *
 * **Orthogonal, not smoothstep.** A P&ID is drawn with square corners, and the
 * rounded ones React Flow supplies by default read as a flow chart.
 *
 * **Any segment moves.** Automatic routing puts a crossbar halfway, which is
 * exactly where the next line also wants to be, and a bay with eight lines
 * leaving one tank turns into a stack of overlapping runs nobody can follow.
 * Each segment has a grip; drag it and the segment moves across, the two
 * ends stay on their ports, and the corners are stored on the line (see
 * `routeThrough`) so the routing somebody chose survives a reload. Alt-drag
 * puts a detour into a segment instead of moving the whole of it. Double-
 * click a grip and the line routes itself again.
 *
 * **Press anywhere on a line and pull, and you are drawing a branch.** The
 * dot riding the pointer along the run is where the tee will go. A press
 * that does not move is a click, and still selects the line. Alt-click, or
 * the Junction tool, puts a tee in without drawing anything from it.
 *
 * **Lines that cross are not joined**, and the drawing says so: the vertical
 * one hops the horizontal one. Nothing here infers a connection from two
 * paths overlapping -- a crossing on a drawing is usually one line passing
 * over another, and guessing wrong either invents a leak path or hides a
 * real one.
 */
export function BranchableEdge(props: EdgeProps) {
  const {
    id,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    style, data, selected,
  } = props;

  const { setNodes, setEdges, getNodes, getEdges, screenToFlowPosition } = useReactFlow();
  const readOnly = useReadOnly();
  const tool = useTool();
  const done = useToolDone();
  const { begin, active: pulling } = useBranchDrag();
  const armed = tool === 'junction' && !readOnly;

  const strokeColor = useEdgeFluidColor(id, (data as { color?: string })?.color);
  const routing = data as { offset?: number; waypoints?: Pt[] } | undefined;

  // ── The run ────────────────────────────────────────────────────────────────
  const a: End = { x: sourceX, y: sourceY, side: sourcePosition };
  const b: End = { x: targetX, y: targetY, side: targetPosition };
  const waypoints = routing?.waypoints;
  const offset = routing?.offset ?? 0;
  const pts = useMemo(() => {
    const route = waypoints?.length ? routeThrough(a, b, waypoints) : routeOrthogonal(a, b, offset);
    return pathPoints(route.d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, waypoints, offset]);

  // Tell the other lines where this one is, and find out where they are.
  useLayoutEffect(() => { publishEdge(id, pts); }, [id, pts]);
  useEffect(() => () => unpublishEdge(id), [id]);
  const others = useOtherEdges(id);
  const hops = useMemo(() => crossingsOf(pts, others), [pts, others]);
  const drawn = useMemo(() => pathWithHops(pts, hops), [pts, hops]);

  const toFlow = useCallback((e: { clientX: number; clientY: number }) =>
    screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false }), [screenToFlowPosition]);

  // ── Hovering: the dot that rides the run ───────────────────────────────────
  const [hover, setHover] = useState<Pt | null>(null);
  const [overGrip, setOverGrip] = useState(false);
  const onMouseMove = useCallback((e: React.MouseEvent<SVGGElement>) => {
    if (readOnly || pulling) return;
    const near = nearestOnPolyline(pts, toFlow(e));
    setHover(near ? near.point : null);
  }, [readOnly, pulling, pts, toFlow]);

  // ── Moving a segment ───────────────────────────────────────────────────────
  const [drag, setDrag] = useState<{ segment: number; jog: boolean; start: Pt; at: Pt; base: Pt[] } | null>(null);

  const startSegmentDrag = useCallback((segment: number, e: React.PointerEvent) => {
    if (readOnly || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const start = toFlow(e);
    setDrag({ segment, jog: e.altKey, start, at: start, base: pts });
  }, [readOnly, pts, toFlow]);

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const now = toFlow(e);
      const delta = { x: now.x - drag.start.x, y: now.y - drag.start.y };
      const next = drag.jog
        ? jogSegment(drag.base, drag.segment, drag.at, delta)
        : dragSegment(drag.base, drag.segment, delta);
      setEdges(eds => eds.map(ed =>
        ed.id === id ? { ...ed, data: { ...ed.data, waypoints: waypointsOf(next), offset: 0 } } : ed));
    };
    const onUp = () => setDrag(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, id, setEdges, toFlow]);

  /** Back to routing itself. */
  const resetRoute = useCallback((e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    setEdges(eds => eds.map(ed => {
      if (ed.id !== id) return ed;
      const rest = { ...ed.data } as Record<string, unknown>;
      delete rest.waypoints;
      delete rest.offset;
      return { ...ed, data: rest };
    }));
  }, [readOnly, id, setEdges]);

  // ── Putting a tee in, or pulling a line out ────────────────────────────────
  const placeJunction = useCallback((at: Pt) => {
    // The same operation dropping a connection on a line performs -- see
    // splitEdge.ts. No page argument: a junction belongs on the page its own
    // pipe is drawn on, and `splitEdgeAt` reads that off the line's upstream
    // end. The exact ends and corners go with it, which a caller working from
    // the node boxes would not have.
    const split = splitEdgeAt(getNodes(), getEdges(), id, at, undefined, { a, b, points: pts });
    if (!split) return;
    flushSync(() => {
      setNodes(split.nodes);
      setEdges(split.edges);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pts, getNodes, getEdges, setNodes, setEdges, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition]);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGGElement>) => {
    if (readOnly || e.button !== 0 || overGrip) return;
    const near = nearestOnPolyline(pts, toFlow(e));
    if (!near) return;
    // Stop React Flow reading this as a pan or a box-select. Clicks and
    // double-clicks are separate events and still reach it.
    e.stopPropagation();
    e.preventDefault();
    if (armed || e.altKey) {
      placeJunction(near.point);
      if (armed) done();
      return;
    }
    begin({ kind: 'line', edgeId: id, at: near.point, dir: near.dir, points: pts }, e);
  }, [readOnly, overGrip, pts, toFlow, armed, placeJunction, done, begin, id]);

  // ── Grips: one per segment ─────────────────────────────────────────────────
  const grips = useMemo(() => {
    const out: { i: number; x: number; y: number; horizontal: boolean }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p = pts[i], q = pts[i + 1];
      if (Math.hypot(q.x - p.x, q.y - p.y) < 24) continue;   // too short to hold
      out.push({ i, x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, horizontal: Math.abs(p.y - q.y) < 1e-6 });
    }
    return out;
  }, [pts]);
  const showGrips = !readOnly && !pulling && (hover !== null || selected || drag !== null);
  const showDot = !readOnly && !pulling && hover !== null && !overGrip && drag === null;

  return (
    <g
      onMouseMove={onMouseMove}
      onMouseLeave={() => { setHover(null); setOverGrip(false); }}
      onPointerDown={onPointerDown}
      style={{ cursor: armed ? 'crosshair' : 'pointer' }}
    >
      {/* Invisible fat hit area, so a 2 px line can be clicked at all. */}
      <path d={drawn} fill="none" stroke="transparent" strokeWidth={12} />
      <BaseEdge path={drawn} style={{ stroke: strokeColor, strokeWidth: 2, ...style }} />

      {showDot && (
        <circle
          cx={hover!.x} cy={hover!.y} r={armed ? 5 : 4}
          fill={armed ? strokeColor : 'var(--color-bg-primary)'} stroke={strokeColor} strokeWidth={2}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {showGrips && grips.map(g => (
        <g
          key={g.i}
          onPointerDown={e => startSegmentDrag(g.i, e)}
          onMouseEnter={() => setOverGrip(true)}
          onMouseLeave={() => setOverGrip(false)}
          onMouseMove={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          onDoubleClick={resetRoute}
          // React Flow sets `pointer-events: visibleStroke` on an edge, so a
          // shape with a fill and no stroke is invisible to the pointer no
          // matter how large it is. The grip needs saying explicitly.
          style={{ cursor: g.horizontal ? 'ns-resize' : 'ew-resize', pointerEvents: 'all' }}
        >
          {/* A generous invisible target over a small visible one. */}
          <rect
            x={g.x - (g.horizontal ? 16 : 8)} y={g.y - (g.horizontal ? 8 : 16)}
            width={g.horizontal ? 32 : 16} height={g.horizontal ? 16 : 32}
            fill="transparent" style={{ pointerEvents: 'all' }}
          />
          <rect
            x={g.x - (g.horizontal ? 7 : 1.5)} y={g.y - (g.horizontal ? 1.5 : 7)}
            width={g.horizontal ? 14 : 3} height={g.horizontal ? 3 : 14} rx={1.5}
            fill={drag?.segment === g.i ? 'var(--color-text-primary)' : strokeColor}
            opacity={drag?.segment === g.i ? 1 : 0.6}
            style={{ pointerEvents: 'all' }}
          />
        </g>
      ))}
    </g>
  );
}
