import { useRef, useState, useCallback } from 'react';
import { flushSync } from 'react-dom';
import {
  BaseEdge,
  getSmoothStepPath,
  Position,
  useReactFlow,
  type EdgeProps,
  type Edge,
} from '@xyflow/react';
import { FLUID_COLORS, type FluidType } from './types';

let _jid = 1;
const jid = () => `junc_${_jid++}`;

const J_HALF = 5;

export function BranchableEdge(props: EdgeProps) {
  const {
    id, source, sourceHandle, target, targetHandle,
    sourceX, sourceY, targetX, targetY,
    sourcePosition, targetPosition,
    style, data,
  } = props;

  const { setNodes, setEdges } = useReactFlow();
  const pathRef = useRef<SVGPathElement>(null);
  const [dot, setDot] = useState<{ svgX: number; svgY: number } | null>(null);

  const overrideSourcePos = (data as { sourcePosition?: Position })?.sourcePosition;
  const overrideTargetPos = (data as { targetPosition?: Position })?.targetPosition;

  const dx = Math.abs(sourceX - targetX);
  const dy = Math.abs(sourceY - targetY);
  const ALIGN_THRESHOLD = 15;

  let edgePath: string;
  if (dx < ALIGN_THRESHOLD && dy > dx) {
    edgePath = `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  } else if (dy < ALIGN_THRESHOLD && dx > dy) {
    edgePath = `M ${sourceX},${sourceY} L ${targetX},${targetY}`;
  } else {
    [edgePath] = getSmoothStepPath({
      sourceX, sourceY, sourcePosition: overrideSourcePos ?? sourcePosition,
      targetX, targetY, targetPosition: overrideTargetPos ?? targetPosition,
    });
  }

  const fluidType = (data as { fluidType?: FluidType })?.fluidType ?? 'default';
  const strokeColor = FLUID_COLORS[fluidType];

  const onMouseMove = useCallback((e: React.MouseEvent<SVGGElement>) => {
    const svg = (e.currentTarget as SVGElement).closest('svg');
    if (!svg || !pathRef.current) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    setDot({ svgX: svgPt.x, svgY: svgPt.y });
  }, []);

  const onMouseLeave = useCallback(() => setDot(null), []);

  const onClickBranch = useCallback((e: React.MouseEvent<SVGGElement>) => {
    if (!dot) return;
    e.stopPropagation();

    const junctionId = jid();
    const junctionNode = {
      id: junctionId,
      type: 'JUNCTION',
      position: { x: dot.svgX - J_HALF, y: dot.svgY - J_HALF },
      data: {},
    };

    flushSync(() => {
      setNodes(nds => [...nds, junctionNode]);
      setEdges(eds => {
        const filtered = eds.filter(e => e.id !== id);
        const toJunction: Edge = {
          id: `${id}-to-${junctionId}`,
          source,
          sourceHandle: sourceHandle ?? undefined,
          target: junctionId,
          targetHandle: 't',
          type: 'smoothstep',
          style: { stroke: strokeColor, strokeWidth: 2 },
          data: { fluidType, sourcePosition: overrideSourcePos ?? sourcePosition, targetPosition: Position.Top },
        };
        const fromJunction: Edge = {
          id: `${junctionId}-to-${target}`,
          source: junctionId,
          sourceHandle: 'b',
          target,
          targetHandle: targetHandle ?? undefined,
          type: 'smoothstep',
          style: { stroke: strokeColor, strokeWidth: 2 },
          data: { fluidType, sourcePosition: Position.Bottom, targetPosition: overrideTargetPos ?? targetPosition },
        };
        return [...filtered, toJunction, fromJunction];
      });
    });
  }, [dot, id, source, sourceHandle, target, targetHandle, strokeColor, fluidType,
      overrideSourcePos, overrideTargetPos, sourcePosition, targetPosition,
      setNodes, setEdges]);

  return (
    <g
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      onClick={onClickBranch}
      style={{ cursor: dot ? 'crosshair' : 'pointer' }}
    >
      {/* Invisible fat hit area */}
      <path d={edgePath} fill="none" stroke="transparent" strokeWidth={12} />
      <BaseEdge
        path={edgePath}
        style={{ stroke: strokeColor, strokeWidth: 2, ...style }}
      />
      {dot && (
        <circle
          cx={dot.svgX}
          cy={dot.svgY}
          r={5}
          fill={strokeColor}
          stroke="#0f172a"
          strokeWidth={2}
          style={{ pointerEvents: 'none' }}
        />
      )}
    </g>
  );
}
