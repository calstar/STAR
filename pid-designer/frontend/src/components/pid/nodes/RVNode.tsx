import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';

const W = 60, H = 60;

export function RVNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';

  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Port position={Position.Left}  id="l" style={{ top: '50%' }} />
      <Port position={Position.Right} id="r" style={{ top: '50%' }} />

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <polygon points="6,18 54,42 54,18 6,42"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <polyline points="20,18 24,10 28,18 32,10 36,18 40,10"
          fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
        <line x1="30" y1="10" x2="30" y2="18" stroke={stroke} strokeWidth={1.5} />
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} rotation={rotation} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
