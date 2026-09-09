import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { speciesById, colorForSpecies, UNSET_COLOR } from '../fluids';
import { useNodeFluid } from '../FluidContext';
import { DraggableLabel } from './DraggableLabel';
import { portId, portKind } from '../ports';

const TANK_W = 60, TANK_H = 100;
const INJ_W = 60, INJ_H = 100;

/**
 * Ports across one end of the tank, evenly spaced.
 *
 * A tank lid carries a pressurant inlet, a vent, a burst disc and whatever
 * instrumentation is tapped into it. Drawing one port forces all of that onto a
 * single line and a fan of edges leaving the same pixel, which is the mess the
 * port count exists to undo. Ids are stable per index (`t1`, `t2`, ...), so
 * reducing the count and putting it back does not orphan the edges that were
 * already drawn to the ports that remain.
 */
function endPorts(
  n: number, prefix: 't' | 'b', position: Position, width: number, data: PIDNodeData,
) {
  const count = Math.max(1, Math.min(4, n));
  return Array.from({ length: count }, (_, i) => {
    const pid = portId(prefix, i);
    const kind = portKind(data, pid);
    if (kind === 'plug') return null;
    return (
      <Port
        key={pid}
        id={pid}
        kind={kind}
        position={position}
        style={{ left: (width * (i + 1)) / (count + 1) }}
      />
    );
  });
}

export function TankNode({ id, data, selected }: NodeProps) {
  const { componentType, label, labelOffset, rotation, options, color } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  // Declared here, or inherited from whatever feeds it. Naming the species on
  // the symbol is the point of picking a real one: "ETH" and "LOX" are what a
  // reader is checking, and "fuel" never told them which fuel.
  const assigned = useNodeFluid(id);
  const species = speciesById(assigned?.species ?? undefined);
  const fluidColor = color ?? (species ? colorForSpecies(species.id) : UNSET_COLOR);
  const isInjector = componentType === 'INJECTOR';

  if (isInjector) {
    return (
      <div style={{ position: 'relative', width: INJ_W, height: INJ_H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
        <Port position={Position.Top}    id="t" />
        <Port position={Position.Bottom} id="b" />

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
      {endPorts(Number(options?.portsTop ?? 1), 't', Position.Top, TANK_W, data as unknown as PIDNodeData)}
      {endPorts(Number(options?.portsBottom ?? 1), 'b', Position.Bottom, TANK_W, data as unknown as PIDNodeData)}

      <svg width={TANK_W} height={TANK_H} viewBox={`0 0 ${TANK_W} ${TANK_H}`}>
        <ellipse cx="30" cy="14" rx="24" ry="9"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <rect x="6" y="14" width="48" height="70"
          fill={fluidColor + '22'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <ellipse cx="30" cy="84" rx="24" ry="9"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <text x="30" y="52" textAnchor="middle" fontSize="10" fill={fluidColor}
          fontFamily="monospace" fontWeight="bold">
          {species?.short ?? 'TANK'}
        </text>
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: TANK_H + 2 }} />
    </div>
  );
}
