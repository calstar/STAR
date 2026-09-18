import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  BaseEdge,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react';
import { splitEdgeAt } from './splitEdge';
import { isHorizontal, routeOrthogonal } from './route';
import { useEdgeFluidColor } from './FluidContext';
import { useReadOnly } from '@stardesign-ui';
import { useTool } from './ToolContext';

/**
 * A pipe: orthogonal, with a middle segment you can move, and a junction you
 * can drop anywhere along it.
 *
 * **Orthogonal, not smoothstep.** A P&ID is drawn with square corners, and the
 * rounded ones React Flow supplies by default read as a flow chart. The path is
 * three segments -- out, across, in -- which is also what makes the middle one
 * a thing you can grab.
 *
 * **The middle segment moves.** Automatic routing puts it halfway, which is
 * exactly where the next line also wants to be, and a bay with eight lines
 * leaving one tank turns into a stack of overlapping runs nobody can follow.
 * Drag the handle and the crossbar moves; the offset is stored on the edge, so
 * the routing somebody chose survives a reload rather than being recomputed
 * into the same mess.
 *
 * **Lines that cross are not joined.** Nothing here infers a connection from
 * two paths overlapping -- a crossing on a drawing is usually one line passing
 * over another, and guessing wrong either invents a leak path or hides a real
 * one. Click a line to put a junction on it where you do mean them to meet;
 * the checks panel counts crossings that have no junction so the distinction is
 * visible rather than assumed.
 */
export function BranchableEdge(props: EdgeProps) {
  const {
    id,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    style, data,
  } = props;

  const { setNodes, setEdges, getNodes, getEdges, getZoom } = useReactFlow();
  const readOnly = useReadOnly();
  // A junction only goes in while the tool is armed. See ToolContext.
  const armed = useTool() === 'junction' && !readOnly;
  const [hoverAt, setHoverAt] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ pointer: number; offset: number } | null>(null);

  const strokeColor = useEdgeFluidColor(id, (data as { color?: string })?.color);
  const offset = ((data as { offset?: number })?.offset ?? 0);

  // The shape of the run, and whether it has a crossbar to drag. See route.ts:
  // the rule is that every segment touching an end leaves that end the way the
  // end points, which is what stops a line doubling back over its own symbol.
  const { d: edgePath, grip } = routeOrthogonal(
    { x: sourceX, y: sourceY, side: sourcePosition },
    { x: targetX, y: targetY, side: targetPosition },
    offset,
  );
  // Which way a drag on the crossbar moves it: across the run, so along the
  // axis the two ends leave on.
  const horizontal = isHorizontal(sourcePosition);

  // ── Moving the crossbar ────────────────────────────────────────────────────
  const startDrag = useCallback((e: React.PointerEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    e.preventDefault();
    dragFrom.current = { pointer: horizontal ? e.clientX : e.clientY, offset };
    setDragging(true);
  }, [readOnly, horizontal, offset]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const from = dragFrom.current;
      if (!from) return;
      // Screen pixels to flow units: at 50% zoom the pointer has to travel
      // twice as far for the same move, and without this the crossbar lags.
      const moved = ((horizontal ? e.clientX : e.clientY) - from.pointer) / getZoom();
      setEdges(eds => eds.map(ed =>
        ed.id === id ? { ...ed, data: { ...ed.data, offset: from.offset + moved } } : ed));
    };
    const onUp = () => { setDragging(false); dragFrom.current = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [dragging, horizontal, id, getZoom, setEdges]);

  // ── Dropping a junction on the run ─────────────────────────────────────────
  /**
   * Where a junction would go: the nearest point *on the run*, not the pointer.
   *
   * It used to take the pointer position straight, so a junction landed
   * wherever the cursor happened to be within the twelve-pixel hit area -- up
   * to six pixels off the pipe. The two new edges then ran to a node beside
   * the line they replaced, which is the kink that made this look broken. The
   * path is orthogonal, so snapping to it is a clamp per segment.
   */
  const onMouseMove = useCallback((e: React.MouseEvent<SVGGElement>) => {
    if (!armed || dragging) return;
    const svg = (e.currentTarget as SVGElement).closest('svg');
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    setHoverAt(nearestOnPath(edgePath, p));
  }, [armed, dragging, edgePath]);

  const onClickBranch = useCallback((e: React.MouseEvent<SVGGElement>) => {
    if (!armed || !hoverAt || dragging) return;
    e.stopPropagation();

    // The same operation dropping a connection on a line performs -- see
    // splitEdge.ts. This used to be a second copy of it here, and the two had
    // already drifted: one stamped a junction the delete-rejoin could
    // recognise and the other did not.
    // No page argument: a junction belongs on the page its own pipe is drawn
    // on, and `splitEdgeAt` reads that off the line's upstream end. Pages live
    // on components, so asking the edge would be asking the wrong thing.
    const split = splitEdgeAt(
      getNodes(), getEdges(), id, hoverAt, undefined,
      // The exact handle positions, which this edge knows and a caller working
      // from the node boxes does not.
      { from: { x: sourceX, y: sourceY }, to: { x: targetX, y: targetY } },
    );
    if (!split) return;

    flushSync(() => {
      setNodes(split.nodes);
      setEdges(split.edges);
    });
  }, [armed, hoverAt, dragging, id, getNodes, getEdges, setNodes, setEdges,
      sourceX, sourceY, targetX, targetY]);

  return (
    <g
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHoverAt(null)}
      onClick={onClickBranch}
      style={{ cursor: armed ? 'crosshair' : 'pointer' }}
    >
      {/* Invisible fat hit area, so a 2 px line can be clicked at all. */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={12} />
      <BaseEdge path={edgePath} style={{ stroke: strokeColor, strokeWidth: 2, ...style }} />

      {armed && hoverAt && !dragging && (
        <circle
          cx={hoverAt.x} cy={hoverAt.y} r={5}
          fill={strokeColor} stroke="var(--color-bg-secondary)" strokeWidth={2}
          style={{ pointerEvents: 'none' }}
        />
      )}

      {grip && !readOnly && (
        <g
          onPointerDown={startDrag}
          onMouseMove={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          // React Flow sets `pointer-events: visibleStroke` on an edge, so a
          // shape with a fill and no stroke is invisible to the pointer no
          // matter how large it is. The grip needs saying explicitly.
          style={{ cursor: horizontal ? 'ew-resize' : 'ns-resize', pointerEvents: 'all' }}
        >
          {/* A generous invisible target over a small visible one. */}
          <rect
            x={grip.x - (horizontal ? 8 : 16)}
            y={grip.y - (horizontal ? 16 : 8)}
            width={horizontal ? 16 : 32}
            height={horizontal ? 32 : 16}
            fill="transparent"
            style={{ pointerEvents: 'all' }}
          />
          <rect
            x={grip.x - (horizontal ? 1.5 : 7)}
            y={grip.y - (horizontal ? 7 : 1.5)}
            width={horizontal ? 3 : 14}
            height={horizontal ? 14 : 3}
            rx={1.5}
            fill={dragging ? 'var(--color-text-primary)' : strokeColor}
            opacity={dragging ? 1 : 0.55}
            style={{ pointerEvents: 'all' }}
          />
        </g>
      )}
    </g>
  );
}

/** The corners of an orthogonal path, in order. */
function pointsOf(d: string): { x: number; y: number }[] {
  return [...d.matchAll(/[ML]\s*(-?[\d.]+),(-?[\d.]+)/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]) }));
}

/**
 * The closest point on a polyline to `p`.
 *
 * Clamped to each segment and the best one kept, so a junction always sits on
 * the pipe -- including exactly on a corner, which is where people aim when
 * they want to branch at a bend.
 */
export function nearestOnPath(d: string, p: { x: number; y: number }): { x: number; y: number } {
  const pts = pointsOf(d);
  let best = pts[0] ?? p;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const dist = Math.hypot(p.x - q.x, p.y - q.y);
    if (dist < bestDist) { bestDist = dist; best = q; }
  }
  return best;
}

/**
 * The face of a junction that points at (fx, fy).
 *
 * A junction is a 10 px dot with four ports, and which one a line attaches to
 * decides which way it leaves. Choosing by direction is what keeps the two
 * halves of a split line collinear with the run they replaced.
 */
export function faceTowards(fx: number, fy: number, jx: number, jy: number): string {
  const dx = fx - jx;
  const dy = fy - jy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l';
  return dy >= 0 ? 'b' : 't';
}
