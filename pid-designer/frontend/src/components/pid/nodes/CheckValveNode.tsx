import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Frame } from './Frame';
import { turn } from '../route';

const W = 60, H = 60;

export function CheckValveNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  // The box once turned, so the tag sits under what is drawn.
  const boxH = (rotation ?? 0) % 180 === 90 ? W : H;
  return (
    <Frame nodeId={id} w={W} h={H} rotation={rotation} extra={<>
        <Port position={turn(Position.Left, rotation)}  id="l" />
        <Port position={turn(Position.Right, rotation)} id="r" />
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: boxH + 2 }} />
      </>}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <line x1="30" y1="10" x2="30" y2="50" stroke={stroke} strokeWidth={1.5} />
        <polygon points="30,30 52,16 52,44" fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2 : 1.5} />
        <line x1="12" y1="10" x2="30" y2="30" stroke={stroke} strokeWidth={1.5} />
        <line x1="12" y1="50" x2="30" y2="30" stroke={stroke} strokeWidth={1.5} />
      </svg>
    </Frame>
  );
}
