import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { speciesById, colorForSpecies, UNSET_COLOR } from '../fluids';
import { useNodeFluid } from '../FluidContext';
import { DraggableLabel } from './DraggableLabel';

/**
 * Where the propellant and the pressurant come from: a K-bottle, or a dewar.
 *
 * These are sources in the same sense a run tank is -- they declare a fluid,
 * everything downstream inherits it, and nothing propagates back into them. The
 * reason they are their own symbols rather than tanks with a note is that they
 * are the boundary of the whole system: a solve starts at a bottle pressure,
 * and a reader tracing a line backwards wants to arrive somewhere that says
 * "this is where it comes from" rather than at another cylinder.
 *
 * They also close the last hole in "a valve open on one side is a vent". A fill
 * valve looked like an exception only because the thing it filled from was not
 * drawable; with a dewar on the drawing the valve has two connections and the
 * inference never fires.
 */

const KB_W = 44, KB_H = 96;
const DW_W = 72, DW_H = 76;

export function SupplyNode({ id, data, selected }: NodeProps) {
  const { componentType, label, labelOffset, rotation, color, params } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  const assigned = useNodeFluid(id);
  const species = speciesById(assigned?.species ?? undefined);
  const tint = color ?? (species ? colorForSpecies(species.id) : UNSET_COLOR);
  const p = params?.pressure;

  if (componentType === 'DEWAR') {
    return (
      <div style={{ position: 'relative', width: DW_W, height: DW_H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
        <Port position={Position.Top}    id="t" />
        <Port position={Position.Bottom} id="b" />
        <Port position={Position.Right}  id="r" />

        <svg width={DW_W} height={DW_H} viewBox={`0 0 ${DW_W} ${DW_H}`}>
          <rect x="30" y="1" width="12" height="7" rx="1"
            fill="#1e293b" stroke={stroke} strokeWidth={1.2} />
          <rect x="4" y="8" width="64" height="64" rx="16"
            fill={tint + '1f'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
          {/* the vacuum jacket, which is what makes it a dewar and not a drum */}
          <rect x="12" y="16" width="48" height="48" rx="11"
            fill="none" stroke={stroke} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
          <text x="36" y="43" textAnchor="middle" fontSize="11" fill={tint}
            fontFamily="monospace" fontWeight="bold">
            {species?.short ?? 'DEWAR'}
          </text>
        </svg>

        <DraggableLabel nodeId={id} label={label} offset={labelOffset} rotation={rotation} defaultOffset={{ x: -4, y: DW_H + 2 }} />
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', width: KB_W, height: KB_H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Port position={Position.Top}   id="t" />
      <Port position={Position.Right} id="r" style={{ top: 22 }} />

      <svg width={KB_W} height={KB_H} viewBox={`0 0 ${KB_W} ${KB_H}`}>
        {/* valve stem and cap */}
        <rect x="18" y="1" width="8" height="7" fill="#1e293b" stroke={stroke} strokeWidth={1.1} />
        {/* the bottle: domed shoulder, straight body */}
        <path d={`M6,26 Q6,11 22,9 Q38,11 38,26 L38,${KB_H - 5} Q38,${KB_H - 1} 34,${KB_H - 1} L10,${KB_H - 1} Q6,${KB_H - 1} 6,${KB_H - 5} Z`}
          fill={tint + '1f'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <text x="22" y="52" textAnchor="middle" fontSize="10" fill={tint}
          fontFamily="monospace" fontWeight="bold">
          {species?.short ?? 'KB'}
        </text>
        {p && (
          <text x="22" y="70" textAnchor="middle" fontSize="8" fill="#94a3b8" fontFamily="monospace">
            {p.value}{p.unit === '-' ? '' : p.unit}
          </text>
        )}
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} rotation={rotation} defaultOffset={{ x: -4, y: KB_H + 2 }} />
    </div>
  );
}
