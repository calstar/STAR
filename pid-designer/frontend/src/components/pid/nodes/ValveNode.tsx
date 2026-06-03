import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';

const W = 60, H = 60;

function BowtieWithActuator({ selected, actuatorLabel }: { selected: boolean; actuatorLabel: string }) {
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <polygon points="8,10 52,46 52,10 8,46" fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
      <rect x="22" y="2" width="16" height="10" rx="2" fill="#1e293b" stroke={stroke} strokeWidth={1.2} />
      <text x="30" y="11" textAnchor="middle" fontSize="7" fill="#cbd5e1" fontFamily="monospace">{actuatorLabel}</text>
      <line x1="30" y1="12" x2="30" y2="20" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

function ManualValve({ selected }: { selected: boolean }) {
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <polygon points="8,10 52,46 52,10 8,46" fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
      <rect x="24" y="2" width="12" height="12" rx="2" transform="rotate(45 30 8)"
        fill="#1e293b" stroke={stroke} strokeWidth={1.2} />
    </svg>
  );
}

export function ValveNode({ id, data, selected }: NodeProps<{ data: PIDNodeData }>) {
  const { componentType, label, labelOffset, rotation } = data as unknown as PIDNodeData;
  const actuator = componentType === 'SOL' ? 'S' : 'P';
  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Handle type="target" position={Position.Left}  id="l" style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Right} id="r" style={{ background: '#94a3b8' }} />
      {componentType === 'MAN'
        ? <ManualValve selected={!!selected} />
        : <BowtieWithActuator selected={!!selected} actuatorLabel={actuator} />}
      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
