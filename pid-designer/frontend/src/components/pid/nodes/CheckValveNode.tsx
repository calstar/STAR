import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';

const W = 60, H = 60;

export function CheckValveNode({ id, data, selected }: NodeProps<{ data: PIDNodeData }>) {
  const { label, labelOffset, rotation } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Handle type="target" position={Position.Left}  id="l" style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Right} id="r" style={{ background: '#94a3b8' }} />
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <line x1="30" y1="10" x2="30" y2="50" stroke={stroke} strokeWidth={1.5} />
        <polygon points="30,30 52,16 52,44" fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2 : 1.5} />
        <line x1="12" y1="10" x2="30" y2="30" stroke={stroke} strokeWidth={1.5} />
        <line x1="12" y1="50" x2="30" y2="30" stroke={stroke} strokeWidth={1.5} />
      </svg>
      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
