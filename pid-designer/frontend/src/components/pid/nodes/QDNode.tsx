import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Upright } from './Upright';

const W = 60, H = 60;

/**
 * A quick disconnect: fluid, or hydraulic.
 *
 * The two are functionally the same and are told apart on sight -- a hydraulic
 * body is dashed -- so nobody traces an actuation line looking for propellant.
 * Which half mates with which is named in the config rather than drawn, because
 * it is a relationship between two symbols and not a property of either.
 */
export function QDNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, options } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  const hydraulic = options?.service === 'hydraulic';

  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Port position={Position.Top}    id="t" />
      <Port position={Position.Bottom} id="b" />
      <Port position={Position.Left}   id="l" />
      <Port position={Position.Right}  id="r" />

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <circle
          cx="30" cy="30" r="25"
          fill="#1e293b"
          stroke={stroke}
          strokeWidth={selected ? 2.5 : 1.5}
          // A hydraulic disconnect reads as dashed, so the two are separable in
          // a monochrome print as well as on screen.
          strokeDasharray={hydraulic ? '5 3' : undefined}
        />
        <line x1="14" y1="14" x2="46" y2="46" stroke={stroke} strokeWidth={2} />
        <line x1="46" y1="14" x2="14" y2="46" stroke={stroke} strokeWidth={2} />
        {hydraulic && (
          <Upright rotation={rotation} cx={W / 2} cy={H / 2}>
            <text x="30" y="52" textAnchor="middle" fontSize="7" fill="#a78bfa" fontFamily="monospace">HYD</text>
          </Upright>
        )}
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} rotation={rotation} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
