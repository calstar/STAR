import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';

const W = 60, H = 60;

export function QDNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';

  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Port position={Position.Top}    id="t" />
      <Port position={Position.Bottom} id="b" />
      <Port position={Position.Left}   id="l" />
      <Port position={Position.Right}  id="r" />

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <circle cx="30" cy="30" r="25" fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <line x1="14" y1="14" x2="46" y2="46" stroke={stroke} strokeWidth={2} />
        <line x1="46" y1="14" x2="14" y2="46" stroke={stroke} strokeWidth={2} />
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
