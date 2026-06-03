import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';

const W = 60, H = 60;

export function SensorNode({ id, data, selected }: NodeProps) {
  const { componentType, label, labelOffset, rotation } = data as unknown as PIDNodeData;

  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Handle type="target" position={Position.Top}    id="t" style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Bottom} id="b" style={{ background: '#94a3b8' }} />
      <Handle type="target" position={Position.Left}   id="l" style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Right}  id="r" style={{ background: '#94a3b8' }} />

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <circle
          cx="30" cy="30" r="26"
          fill="#1e293b"
          stroke={selected ? '#3b82f6' : '#94a3b8'}
          strokeWidth={selected ? 2.5 : 1.5}
        />
        <text x="30" y="34" textAnchor="middle" fontSize="10" fill="#e2e8f0" fontFamily="monospace" fontWeight="bold">
          {componentType}
        </text>
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
