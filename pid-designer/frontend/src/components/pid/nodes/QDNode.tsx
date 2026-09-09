import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';

const W = 60, H = 60;

/**
 * A quick disconnect.
 *
 * Two things are drawn on it rather than left in the config, because both are
 * read at a glance and both are the sort of thing that goes wrong quietly.
 *
 * **Which side of the umbilical it is.** A rocket half leaves with the vehicle
 * and a ground half stays behind, so a pair with two ground halves is a fill
 * line nobody can disconnect. The marking is what makes that visible on the
 * drawing instead of in a dialog.
 *
 * **Fluid or hydraulic.** Functionally the same, and told apart on sight so
 * nobody traces a hydraulic actuation line looking for propellant.
 */
export function QDNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, options } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  const rocket = options?.side === 'rocket';
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
        <text
          x="30" y="15" textAnchor="middle" fontSize="8"
          fill={rocket ? '#f59e0b' : '#64748b'} fontFamily="monospace" fontWeight="bold"
        >
          {rocket ? 'R' : 'G'}
        </text>
        {hydraulic && (
          <text x="30" y="52" textAnchor="middle" fontSize="7" fill="#a78bfa" fontFamily="monospace">HYD</text>
        )}
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
