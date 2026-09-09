import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { FLUID_COLORS } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { portId, portKind } from '../ports';

/**
 * A manifold: one feed in, several out.
 *
 * The reason to draw one rather than fan eight lines off a tank port is that
 * the hardware *is* a block with a bore through it and ports tapped into the
 * side, and a drawing that hides it turns into the mess it was hiding. It is
 * also a real node in a solve -- a plenum, plus one branch per port -- rather
 * than a drafting convenience.
 *
 * Port count is per-side and set from the config dialog, because how many
 * ports a block has is a property of that block, not of manifolds.
 */

const BODY = 26;
const PITCH = 26;
const PAD = 14;

/** Evenly spaced port offsets along a run of `n` ports. */
function portOffsets(n: number): number[] {
  return Array.from({ length: n }, (_, i) => PAD + i * PITCH);
}

function manifoldLength(ports: number): number {
  return Math.max(2, ports) * PITCH + PAD;
}

export function ManifoldNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, fluidType, rotation, options } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  const fluid = FLUID_COLORS[fluidType ?? 'default'];

  const outlets = Math.max(1, Number(options?.outlets ?? 4));
  const vertical = (options?.orientation ?? 'horizontal') === 'vertical';

  const run = manifoldLength(outlets);
  const W = vertical ? BODY : run;
  const H = vertical ? run : BODY;

  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      {/* The feed in, at the near end. */}
      <Port position={vertical ? Position.Top : Position.Left} id="in" />

      {/* One tapping per outlet, down the long side. A plugged one is not
          drawn at all -- a P&ID does not draw plugs, and a port nothing can
          attach to is exactly what a plug is. */}
      {portOffsets(outlets).map((off, i) => {
        const pid = portId('p', i);
        const kind = portKind(data as unknown as PIDNodeData, pid);
        if (kind === 'plug') return null;
        return (
          <Port
            key={pid}
            id={pid}
            kind={kind}
            position={vertical ? Position.Right : Position.Bottom}
            style={vertical ? { top: off } : { left: off }}
          />
        );
      })}

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <rect x="1" y="1" width={W - 2} height={H - 2} rx="3"
          fill={fluid + '22'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        {/* the bore through it */}
        {vertical
          ? <line x1={W / 2} y1="4" x2={W / 2} y2={H - 4} stroke={stroke} strokeWidth={1} strokeDasharray="3 3" />
          : <line x1="4" y1={H / 2} x2={W - 4} y2={H / 2} stroke={stroke} strokeWidth={1} strokeDasharray="3 3" />}
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
