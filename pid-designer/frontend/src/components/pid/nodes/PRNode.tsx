import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';

const W = 60, H = 60;

export function PRNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';

  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Handle type="target" position={Position.Left}  id="l" style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Right} id="r" style={{ background: '#94a3b8' }} />
      <Handle type="target" position={Position.Top}   id="t" style={{ background: '#94a3b8' }} />

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <line x1="30" y1="0" x2="30" y2="8" stroke={stroke} strokeWidth={1.5} />
        <rect x="8" y="8" width="44" height="44" rx="3"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <line x1="16" y1="44" x2="44" y2="16" stroke={stroke} strokeWidth={1.5} />
        <polygon points="44,16 36,18 42,24" fill={stroke} />
        <text x="16" y="28" fontSize="9" fill="#e2e8f0" fontFamily="monospace">PR</text>
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
