import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { useEffect } from 'react';
import { Frame, TurnedPort } from './Frame';
import type { PIDNodeData } from '../types';
import { colorForSpecies, speciesById, UNSET_COLOR } from '../fluids';
import { useNodeFluid } from '../FluidContext';
import { DraggableLabel } from './DraggableLabel';
import { portId, portIds, portKind } from '../ports';
import { perimeterPoint, defaultPositions } from '../ManifoldEditor';

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
  const { label, labelOffset, rotation, options, color } = data as unknown as PIDNodeData;
  // Paint beats the inherited fluid colour, and both beat nothing. This read
  // the old `fluidType` field and never looked at `color` at all, which is why
  // a manifold was the one symbol the paint bucket appeared to miss.
  const assigned = useNodeFluid(id);
  const species = speciesById(assigned?.species ?? undefined);
  const fluid = color ?? (species ? colorForSpecies(species.id) : UNSET_COLOR);
  const stroke = selected ? 'var(--color-text-primary)' : (color ?? 'var(--color-text-secondary)');

  const outlets = Math.max(1, Number(options?.outlets ?? 4));

  // See TankNode: handle bounds are measured once, so a changed port count has
  // to ask for a re-measure or edges fall back to the node centre.
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = `${outlets}/${options?.orientation ?? 'horizontal'}/` +
    `${JSON.stringify((data as unknown as PIDNodeData).geometry ?? null)}/` +
    Object.entries((data as unknown as PIDNodeData).ports ?? {})
      .map(([k, v]) => `${k}:${v.kind ?? 'flow'}`).sort().join(',');
  useEffect(() => { updateNodeInternals(id); }, [id, portSignature, updateNodeInternals]);
  const vertical = (options?.orientation ?? 'horizontal') === 'vertical';

  // A saved layout wins; without one the block is the even default it always
  // was, so nothing that exists changes shape.
  const geom = (data as unknown as PIDNodeData).geometry;
  const run = manifoldLength(outlets);
  const W = geom ? geom.width : vertical ? BODY : run;
  const H = geom ? geom.height : vertical ? run : BODY;

  const quarter = (rotation ?? 0) % 180 === 90;
  const boxH = quarter ? W : H;

  const ports = geom ? (
    // Placed by hand: each port sits where its perimeter fraction puts it.
    (() => {
      const ids = ['in', ...portIds('p', outlets)];
      const spare = defaultPositions(ids);
      return ids.map(pid => {
        if (portKind(data as unknown as PIDNodeData, pid) === 'plug') return null;
        const pt = perimeterPoint(geom.positions[pid] ?? spare[pid], W, H);
        const side =
          pt.side === 'top' ? Position.Top
          : pt.side === 'bottom' ? Position.Bottom
          : pt.side === 'left' ? Position.Left
          : Position.Right;
        const along = pt.side === 'top' || pt.side === 'bottom' ? pt.x : pt.y;
        return (
          <TurnedPort key={pid} nodeId={id} id={pid} side={side} along={along}
            w={W} h={H} rotation={rotation ?? 0} />
        );
      });
    })()
  ) : (
    <>
      {/* The feed in, at the near end. */}
      <TurnedPort nodeId={id} id="in" side={vertical ? Position.Top : Position.Left}
        w={W} h={H} rotation={rotation ?? 0} />

      {/* One tapping per outlet, down the long side. A plugged one is not
          drawn at all -- a P&ID does not draw plugs. */}
      {portOffsets(outlets).map((off, i) => {
        const pid = portId('p', i);
        if (portKind(data as unknown as PIDNodeData, pid) === 'plug') return null;
        return (
          <TurnedPort key={pid} nodeId={id} id={pid}
            side={vertical ? Position.Right : Position.Bottom}
            along={off} w={W} h={H} rotation={rotation ?? 0} />
        );
      })}
    </>
  );

  return (
    <Frame
      nodeId={id} w={W} h={H} rotation={rotation}
      extra={<>
        {ports}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: boxH + 2 }} />
      </>}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <rect x="1" y="1" width={W - 2} height={H - 2} rx="3"
          fill={fluid + '22'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        {/* the bore through it */}
        {vertical
          ? <line x1={W / 2} y1="4" x2={W / 2} y2={H - 4} stroke={stroke} strokeWidth={1} strokeDasharray="3 3" />
          : <line x1="4" y1={H / 2} x2={W - 4} y2={H / 2} stroke={stroke} strokeWidth={1} strokeDasharray="3 3" />}
      </svg>
    </Frame>
  );
}
