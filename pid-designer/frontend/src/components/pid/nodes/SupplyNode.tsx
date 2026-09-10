import { Position, type NodeProps } from '@xyflow/react';
import type { PIDNodeData } from '../types';
import { speciesById, colorForSpecies, UNSET_COLOR } from '../fluids';
import { useNodeFluid } from '../FluidContext';
import { DraggableLabel } from './DraggableLabel';
import { Frame, TurnedPort } from './Frame';
import { Upright } from './Upright';

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
  // The box each symbol occupies once turned, so what sits under it -- the
  // bottle pressure, the tag -- follows the picture rather than the unturned
  // dimensions.
  const quarter = (rotation ?? 0) % 180 === 90;
  const dewarBoxH = quarter ? DW_W : DW_H;
  const bottleBoxH = quarter ? KB_W : KB_H;

  if (componentType === 'DEWAR') {
    return (
      <Frame
        w={DW_W} h={DW_H} rotation={rotation}
        extra={<>
          <TurnedPort nodeId={id} id="t" side={Position.Top}    w={DW_W} h={DW_H} rotation={rotation} />
          <TurnedPort nodeId={id} id="b" side={Position.Bottom} w={DW_W} h={DW_H} rotation={rotation} />
          <TurnedPort nodeId={id} id="r" side={Position.Right}  w={DW_W} h={DW_H} rotation={rotation} />
          <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: dewarBoxH + 2 }} />
        </>}
      >

        <svg width={DW_W} height={DW_H} viewBox={`0 0 ${DW_W} ${DW_H}`}>
          <rect x="30" y="1" width="12" height="7" rx="1"
            fill="#1e293b" stroke={stroke} strokeWidth={1.2} />
          <rect x="4" y="8" width="64" height="64" rx="16"
            fill={tint + '1f'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
          {/* the vacuum jacket, which is what makes it a dewar and not a drum */}
          <rect x="12" y="16" width="48" height="48" rx="11"
            fill="none" stroke={stroke} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
          <Upright rotation={rotation} cx={DW_W / 2} cy={DW_H / 2}>
            <text x="36" y="43" textAnchor="middle" fontSize="11" fill={tint}
              fontFamily="monospace" fontWeight="bold">
              {species?.short ?? 'DEWAR'}
            </text>
          </Upright>
        </svg>

      </Frame>
    );
  }

  return (
    <Frame
      w={KB_W} h={KB_H} rotation={rotation}
      extra={<>
        <TurnedPort nodeId={id} id="t" side={Position.Top}   w={KB_W} h={KB_H} rotation={rotation} />
        <TurnedPort nodeId={id} id="r" side={Position.Right} along={22} w={KB_W} h={KB_H} rotation={rotation} />
        {p && (
          <span
            style={{
              position: 'absolute', left: '50%', top: bottleBoxH + 1,
              transform: 'translateX(-50%)',
              fontSize: 9, lineHeight: 1, fontFamily: 'monospace',
              color: '#94a3b8', whiteSpace: 'nowrap', pointerEvents: 'none',
            }}
          >
            {p.value} {p.unit}
          </span>
        )}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: bottleBoxH + 15 }} />
      </>}
    >

      <svg width={KB_W} height={KB_H} viewBox={`0 0 ${KB_W} ${KB_H}`}>
        {/* valve stem and cap */}
        <rect x="18" y="1" width="8" height="7" fill="#1e293b" stroke={stroke} strokeWidth={1.1} />
        {/* the bottle: domed shoulder, straight body */}
        <path d={`M6,26 Q6,11 22,9 Q38,11 38,26 L38,${KB_H - 5} Q38,${KB_H - 1} 34,${KB_H - 1} L10,${KB_H - 1} Q6,${KB_H - 1} 6,${KB_H - 5} Z`}
          fill={tint + '1f'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <Upright rotation={rotation} cx={KB_W / 2} cy={KB_H / 2}>
          <text x="22" y="52" textAnchor="middle" fontSize="10" fill={tint}
            fontFamily="monospace" fontWeight="bold">
            {species?.short ?? 'KB'}
          </text>
        </Upright>
      </svg>

    </Frame>
  );
}
