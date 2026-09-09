import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  BaseEdge,
  Position,
  useReactFlow,
  type EdgeProps,
  type Edge,
} from '@xyflow/react';
import { nextJunctionId } from './ids';
import { useEdgeFluidColor } from './FluidContext';
import { useReadOnly } from '@stardesign-ui';

const J_HALF = 5;

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
    id, source, target,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    style, data,
  } = props;

  const { setNodes, setEdges, getZoom } = useReactFlow();
  const readOnly = useReadOnly();
  const [hoverAt, setHoverAt] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ pointer: number; offset: number } | null>(null);

  const strokeColor = useEdgeFluidColor(id, (data as { color?: string })?.color);
  const offset = ((data as { offset?: number })?.offset ?? 0);

  // Which way each end faces decides the shape of the run. Ends that face the
  // same way give three segments with a crossbar in the middle; ends that face
  // differently give a plain corner, which has nothing to move and should not
  // pretend otherwise.
  const isH = (p?: Position) => p === Position.Left || p === Position.Right;
  const horizontal = isH(sourcePosition);
  const sameAxis = isH(sourcePosition) === isH(targetPosition);

  const dx = Math.abs(sourceX - targetX);
  const dy = Math.abs(sourceY - targetY);
  const ALIGNED = 12;

  let edgePath: string;
  let grip: { x: number; y: number } | null = null;

  if ((dx < ALIGNED && dy > dx) || (dy < ALIGNED && dx > dy)) {
    // Already in line: a straight run, and nothing to move.
    edgePath = `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  } else if (!sameAxis) {
    // A corner. Leave along the axis the source faces, then turn once.
    edgePath = horizontal
      ? `M ${sourceX},${sourceY} L ${targetX},${sourceY} L ${targetX},${targetY}`
      : `M ${sourceX},${sourceY} L ${sourceX},${targetY} L ${targetX},${targetY}`;
  } else if (horizontal) {
    const midX = (sourceX + targetX) / 2 + offset;
    edgePath = `M ${sourceX},${sourceY} L ${midX},${sourceY} L ${midX},${targetY} L ${targetX},${targetY}`;
    grip = { x: midX, y: (sourceY + targetY) / 2 };
  } else {
    const midY = (sourceY + targetY) / 2 + offset;
    edgePath = `M ${sourceX},${sourceY} L ${sourceX},${midY} L ${targetX},${midY} L ${targetX},${targetY}`;
    grip = { x: (sourceX + targetX) / 2, y: midY };
  }

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
  const onMouseMove = useCallback((e: React.MouseEvent<SVGGElement>) => {
    if (readOnly || dragging) return;
    const svg = (e.currentTarget as SVGElement).closest('svg');
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    setHoverAt({ x: p.x, y: p.y });
  }, [readOnly, dragging]);

  const onClickBranch = useCallback((e: React.MouseEvent<SVGGElement>) => {
    if (readOnly || !hoverAt || dragging) return;
    e.stopPropagation();

    const junctionId = nextJunctionId();
    flushSync(() => {
      setNodes(nds => [...nds, {
        id: junctionId,
        type: 'JUNCTION',
        position: { x: hoverAt.x - J_HALF, y: hoverAt.y - J_HALF },
        // Junctions inherit the page of the line they are dropped on, so one
        // never lands on a page its own pipe is not drawn on.
        data: { page: (data as { page?: string })?.page },
      }]);
      setEdges(eds => {
        const rest = eds.filter(x => x.id !== id);
        const carried = { ...(data as Record<string, unknown>), offset: 0 };
        const toJunction: Edge = {
          id: `${id}-to-${junctionId}`,
          source, target: junctionId, targetHandle: 't',
          type: 'smoothstep', data: carried,
        };
        const fromJunction: Edge = {
          id: `${junctionId}-to-${target}`,
          source: junctionId, sourceHandle: 'b', target,
          type: 'smoothstep', data: carried,
        };
        return [...rest, toJunction, fromJunction];
      });
    });
  }, [readOnly, hoverAt, dragging, id, source, target, data, setNodes, setEdges]);

  return (
    <g
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHoverAt(null)}
      onClick={onClickBranch}
      style={{ cursor: hoverAt ? 'crosshair' : 'pointer' }}
    >
      {/* Invisible fat hit area, so a 2 px line can be clicked at all. */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={12} />
      <BaseEdge path={edgePath} style={{ stroke: strokeColor, strokeWidth: 2, ...style }} />

      {hoverAt && !dragging && (
        <circle
          cx={hoverAt.x} cy={hoverAt.y} r={5}
          fill={strokeColor} stroke="#0f172a" strokeWidth={2}
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
            fill={dragging ? '#3b82f6' : strokeColor}
            opacity={dragging ? 1 : 0.55}
            style={{ pointerEvents: 'all' }}
          />
        </g>
      )}
    </g>
  );
}
