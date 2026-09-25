import { Position, type NodeProps } from '@xyflow/react';
import type { PIDNodeData } from '../types';
import { speciesById, colorForSpecies, UNSET_COLOR } from '../fluids';
import { useNodeFluid } from '../FluidContext';
import { DraggableLabel } from './DraggableLabel';
import { Frame, TurnedPort } from './Frame';
import { Upright } from './Upright';
import { fmtParam } from '../fmt';

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

/**
 * The supplies' boxes, and how far down a K-bottle's side its outlet sits:
 * what a port is placed from before it is measured.
 *
 * Every one of them a whole number of grid steps, and every port a whole
 * number of steps along its side, so that a supply standing on the 10 px grid
 * has its ports on the grid too -- turned or not, since a turn measures a port
 * from the other end of its side, and that is on the grid only when the side
 * is. The bottle was 44 by 96 with its outlet 22 down, two pixels off the
 * grid, so a line from it to a regulator standing on the grid could never be
 * straight: it drew a jog halfway, too small to read as a bend and too big to
 * miss. The dewar's centred ports sat at 36 and 38. Resized to the nearest boxes that hold them on the grid, which
 * moves no port of a drawing more than four pixels across its line.
 */
export const KB_W = 40, KB_H = 90, KB_OUTLET_ALONG = 20;
export const DW_W = 80, DW_H = 80;

export function SupplyNode({ id, data, selected }: NodeProps) {
  const { componentType, label, labelOffset, rotation, color, params } = data as unknown as PIDNodeData;
  const stroke = selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)';
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
        nodeId={id} w={DW_W} h={DW_H} rotation={rotation}
        extra={<>
          <TurnedPort nodeId={id} id="t" side={Position.Top}    w={DW_W} h={DW_H} rotation={rotation} />
          <TurnedPort nodeId={id} id="b" side={Position.Bottom} w={DW_W} h={DW_H} rotation={rotation} />
          <TurnedPort nodeId={id} id="r" side={Position.Right}  w={DW_W} h={DW_H} rotation={rotation} />
          <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: dewarBoxH + 2 }} />
        </>}
      >

        <svg width={DW_W} height={DW_H} viewBox={`0 0 ${DW_W} ${DW_H}`}>
          <rect x={DW_W / 2 - 6} y="1" width="12" height="9" rx="1"
            fill="var(--color-bg-tertiary)" stroke={stroke} strokeWidth={1.2} />
          <rect x="8" y="10" width={DW_W - 16} height={DW_H - 14} rx="16"
            fill={tint + '1f'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
          {/* the vacuum jacket, which is what makes it a dewar and not a drum */}
          <rect x="16" y="18" width={DW_W - 32} height={DW_H - 30} rx="11"
            fill="none" stroke={stroke} strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
          <Upright rotation={rotation} x={DW_W / 2} y={DW_H / 2 + 6}>
            <text x={DW_W / 2} y={DW_H / 2 + 6} textAnchor="middle" fontSize="11" fill={tint}
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
      nodeId={id} w={KB_W} h={KB_H} rotation={rotation}
      extra={<>
        <TurnedPort nodeId={id} id="t" side={Position.Top}   w={KB_W} h={KB_H} rotation={rotation} />
        <TurnedPort nodeId={id} id="r" side={Position.Right} along={KB_OUTLET_ALONG} w={KB_W} h={KB_H} rotation={rotation} />
        {p && (
          <span
            style={{
              position: 'absolute', left: '50%', top: bottleBoxH + 1,
              transform: 'translateX(-50%)',
              fontSize: 9, lineHeight: 1, fontFamily: 'monospace',
              color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', pointerEvents: 'none',
            }}
          >
            {fmtParam(p)}
          </span>
        )}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: bottleBoxH + 15 }} />
      </>}
    >

      <svg width={KB_W} height={KB_H} viewBox={`0 0 ${KB_W} ${KB_H}`}>
        {/* valve stem and cap */}
        <rect x={KB_W / 2 - 4} y="1" width="8" height="7" fill="var(--color-bg-tertiary)" stroke={stroke} strokeWidth={1.1} />
        {/* the bottle: domed shoulder, straight body */}
        <path d={`M4,26 Q4,11 ${KB_W / 2},9 Q${KB_W - 4},11 ${KB_W - 4},26 L${KB_W - 4},${KB_H - 5} Q${KB_W - 4},${KB_H - 1} ${KB_W - 8},${KB_H - 1} L8,${KB_H - 1} Q4,${KB_H - 1} 4,${KB_H - 5} Z`}
          fill={tint + '1f'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <Upright rotation={rotation} x={KB_W / 2} y={(KB_H + 8) / 2}>
          <text x={KB_W / 2} y={(KB_H + 8) / 2} textAnchor="middle" fontSize="10" fill={tint}
            fontFamily="monospace" fontWeight="bold">
            {species?.short ?? 'KB'}
          </text>
        </Upright>
      </svg>

    </Frame>
  );
}
