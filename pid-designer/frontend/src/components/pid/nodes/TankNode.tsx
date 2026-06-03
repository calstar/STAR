import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PIDNodeData } from '../types';
import { FLUID_COLORS } from '../types';
import { DraggableLabel } from './DraggableLabel';

const TANK_W = 60, TANK_H = 100;
const INJ_W = 60, INJ_H = 100;

export function TankNode({ id, data, selected }: NodeProps) {
  const { componentType, label, labelOffset, fluidType, rotation } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  const fluidColor = FLUID_COLORS[fluidType ?? 'default'];
  const isInjector = componentType === 'INJECTOR';

  if (isInjector) {
    return (
      <div style={{ position: 'relative', width: INJ_W, height: INJ_H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
        <Handle type="target" position={Position.Top}    id="t" style={{ background: '#94a3b8' }} />
        <Handle type="source" position={Position.Bottom} id="b" style={{ background: '#94a3b8' }} />

        <svg width={INJ_W} height={INJ_H} viewBox={`0 0 ${INJ_W} ${INJ_H}`}>
          <rect x="10" y="6" width="40" height="22" rx="2"
            fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
          <text x="30" y="21" textAnchor="middle" fontSize="8" fill="#e2e8f0" fontFamily="monospace">INJ</text>
          <polygon points="10,28 50,28 38,88 22,88"
            fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
          <line x1="22" y1="88" x2="38" y2="88" stroke={stroke} strokeWidth={2} />
        </svg>

        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: INJ_H + 2 }} />
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: TANK_W, height: TANK_H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Handle type="target" position={Position.Top}    id="t" style={{ background: '#94a3b8' }} />
      <Handle type="source" position={Position.Bottom} id="b" style={{ background: '#94a3b8' }} />

      <svg width={TANK_W} height={TANK_H} viewBox={`0 0 ${TANK_W} ${TANK_H}`}>
        <ellipse cx="30" cy="14" rx="24" ry="9"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <rect x="6" y="14" width="48" height="70"
          fill={fluidColor + '22'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <ellipse cx="30" cy="84" rx="24" ry="9"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <text x="30" y="52" textAnchor="middle" fontSize="10" fill={fluidColor}
          fontFamily="monospace" fontWeight="bold">
          {fluidType?.toUpperCase() ?? 'TANK'}
        </text>
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: TANK_H + 2 }} />
    </div>
  );
}
