import { Position, useUpdateNodeInternals, type NodeProps, type XYPosition } from '@xyflow/react';
import { useEffect } from 'react';
import { Frame, TurnedPort } from './Frame';
import type { PIDNodeData } from '../types';
import { colorForSpecies, speciesById, UNSET_COLOR } from '../fluids';
import { useNodeFluid } from '../FluidContext';
import { DraggableLabel } from './DraggableLabel';
import { portIds, portKind } from '../ports';
import { defaultPositions, perimeterPoint } from '../manifoldGeometry';
import type { DrawnPort, ManifoldGeometry, ManifoldLayout, Side } from '../manifoldGeometry';
import { turnPlacement } from '../route';

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

/** How long the block is for `outlets` outlets down one side. */
function manifoldLength(outlets: number): number {
  return Math.max(2, outlets) * PITCH + PAD;
}

/** The ids of a manifold's ports: the feed, then the outlets. */
export const manifoldPortIds = (outlets: number) => ['in', ...portIds('p', outlets)];

/**
 * Where a manifold's ports are, unturned: the one answer this node draws from
 * and the Geometry editor opens on.
 *
 * A saved layout wins. Without one the block is as long as its outlets need,
 * with the feed in the middle of the near end and the outlets evenly down the
 * long side, the way a manifold has always been drawn. The editor used to
 * start from a different picture -- a fixed 120 x 26 block with every port
 * spread round the whole perimeter -- so opening it was already an edit, and
 * saving it untouched moved every port on the drawing.
 */
export function manifoldLayout(
  outlets: number,
  orientation: string | undefined,
  geometry?: ManifoldGeometry,
): ManifoldLayout {
  const ids = manifoldPortIds(outlets);
  const ports: Record<string, DrawnPort> = {};
  if (geometry) {
    const spare = defaultPositions(ids);
    for (const id of ids) {
      const p = perimeterPoint(geometry.positions[id] ?? spare[id], geometry.width, geometry.height);
      ports[id] = { side: p.side, along: p.side === 'top' || p.side === 'bottom' ? p.x : p.y };
    }
    return { width: geometry.width, height: geometry.height, ports };
  }
  const vertical = orientation === 'vertical';
  const run = manifoldLength(outlets);
  const width = vertical ? BODY : run;
  const height = vertical ? run : BODY;
  ports.in = vertical ? { side: 'top', along: width / 2 } : { side: 'left', along: height / 2 };
  ids.slice(1).forEach((id, i) => {
    ports[id] = { side: vertical ? 'right' : 'bottom', along: PAD + i * PITCH };
  });
  return { width, height, ports };
}

const SIDE: Record<Side, Position> = {
  top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left,
};

/** What of a manifold's data decides where its ports are. */
type ManifoldShape = Pick<PIDNodeData, 'rotation' | 'options' | 'geometry'>;

/** Where the feed port lands in the turned box, from the node's top-left. */
function feedAt(data: ManifoldShape): XYPosition {
  const outlets = Math.max(1, Number(data.options?.outlets ?? 4));
  const layout = manifoldLayout(outlets, data.options?.orientation, data.geometry);
  const rotation = data.rotation ?? 0;
  const quarter = Math.round((((rotation % 360) + 360) % 360) / 90) % 2 === 1;
  const bw = quarter ? layout.height : layout.width;
  const bh = quarter ? layout.width : layout.height;
  const port = layout.ports.in;
  const placed = turnPlacement(SIDE[port.side], port.along, layout.width, layout.height, rotation);
  switch (placed.side) {
    case Position.Top: return { x: placed.along, y: 0 };
    case Position.Bottom: return { x: placed.along, y: bh };
    case Position.Left: return { x: 0, y: placed.along };
    default: return { x: bw, y: placed.along };
  }
}

/**
 * How far to move a manifold so its feed stays put through a config edit, or
 * null when it need not move.
 *
 * The block grows and shrinks with its outlet count, and a node is placed by
 * its top-left corner. Unturned, the feed and the outlets are measured from
 * that corner, so a longer block simply grows away from them. Turned so that
 * the feed is at the far end -- half a turn or three quarters horizontally, a
 * quarter or half a turn vertically -- the corner the block grows from is the
 * one *behind* the feed, and changing four outlets to six slid the feed and
 * every existing outlet 52 px along, turning straight drops into Zs and
 * parking new outlets under valves wired to other ones.
 *
 * The outlets sit a fixed distance from the feed whatever the count, so
 * moving the node by however far the feed would have moved keeps all of them
 * where they were. The same holds when the direction changes: the feed stays
 * where it was and the block turns about it. A saved layout fixes the block's
 * size, so an outlet count changes nothing there -- and a patch that saves a
 * new layout is somebody placing the feed on purpose, so it is left alone.
 */
export function manifoldShift(before: ManifoldShape, after: ManifoldShape): XYPosition | null {
  if (JSON.stringify(before.geometry ?? null) !== JSON.stringify(after.geometry ?? null)) return null;
  const a = feedAt(before), b = feedAt(after);
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx === 0 && dy === 0 ? null : { x: dx, y: dy };
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

  // A saved layout wins; without one the block is the default it always was
  // -- the feed mid-way across the near end, the outlets evenly down the long
  // side -- so nothing that exists changes shape. `manifoldLayout` is also
  // what the Geometry editor opens on, so the two cannot disagree.
  const layout = manifoldLayout(outlets, options?.orientation, (data as unknown as PIDNodeData).geometry);
  const W = layout.width;
  const H = layout.height;

  const quarter = (rotation ?? 0) % 180 === 90;
  const boxH = quarter ? W : H;

  // A plugged port is not drawn at all -- a P&ID does not draw plugs.
  const ports = manifoldPortIds(outlets).map(pid => {
    if (portKind(data as unknown as PIDNodeData, pid) === 'plug') return null;
    const port = layout.ports[pid];
    return (
      <TurnedPort key={pid} nodeId={id} id={pid} side={SIDE[port.side]} along={port.along}
        w={W} h={H} rotation={rotation ?? 0} />
    );
  });

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
