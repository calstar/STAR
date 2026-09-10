import { Position, type NodeProps } from '@xyflow/react';
import { Frame, TurnedPort } from './Frame';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Upright } from './Upright';

const W = 72, H = 120;

/**
 * Injector and chamber as one symbol.
 *
 * They were two things on this palette, and on a feed drawing that is the
 * wrong seam: the injector face is where the feed system ends, the chamber
 * pressure behind it is the boundary condition the whole feed runs against,
 * and the pair is built, tested and replaced together. Splitting them made
 * every P&ID carry a line between two symbols that are one part.
 *
 * Two inlets, because a bipropellant engine has two: fuel to the left, ox to
 * the right, with the manifolds drawn as the block above the face. Double-click
 * for chamber pressure, chamber temperature and injector drop.
 */
export function EngineNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, params } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  const pc = params?.chamber_pressure;

  const boxH = (rotation ?? 0) % 180 === 90 ? W : H;
  return (
    <Frame
      w={W} h={H} rotation={rotation}
      extra={<>
        <TurnedPort nodeId={id} id="fuel" side={Position.Left}  along={18} w={W} h={H} rotation={rotation} />
        <TurnedPort nodeId={id} id="ox"   side={Position.Right} along={18} w={W} h={H} rotation={rotation} />
        <TurnedPort nodeId={id} id="t"    side={Position.Top}              w={W} h={H} rotation={rotation} />
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: boxH + 2 }} />
      </>}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* injector manifold block */}
        <rect x="10" y="8" width="52" height="24" rx="2"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        {/* injector face */}
        <line x1="10" y1="32" x2="62" y2="32" stroke={stroke} strokeWidth={2} />
        {[18, 27, 36, 45, 54].map(x => (
          <line key={x} x1={x} y1="32" x2={x} y2="38" stroke={stroke} strokeWidth={1} />
        ))}
        {/* chamber, throat, bell */}
        <path d="M14,32 L14,62 Q14,76 30,84 L42,84 Q58,76 58,62 L58,32"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <path d="M30,84 Q22,100 16,114 L56,114 Q50,100 42,84 Z"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        {/* One wrapper each: the counter-rotation is about the text's own
            anchor, so two texts sharing one would spin the second about the
            first's position and fling it off the symbol. */}
        <Upright rotation={rotation} x={36} y={24}>
          <text x="36" y="24" textAnchor="middle" fontSize="8" fill="#e2e8f0" fontFamily="monospace">INJ</text>
        </Upright>
        {pc && (
          <Upright rotation={rotation} x={36} y={60}>
            <text x="36" y="60" textAnchor="middle" fontSize="8" fill="#f97316" fontFamily="monospace">
              {pc.value}{pc.unit === '-' ? '' : pc.unit}
            </text>
          </Upright>
        )}
      </svg>
    </Frame>
  );
}
