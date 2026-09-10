import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { Frame, TurnedPort } from './Frame';
import type { PIDNodeData } from '../types';
import { speciesById, colorForSpecies, UNSET_COLOR } from '../fluids';
import { useNodeFluid } from '../FluidContext';
import { DraggableLabel } from './DraggableLabel';
import { Upright } from './Upright';
import { portId, portKind } from '../ports';
import { useEffect } from 'react';

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
  n: number, prefix: 't' | 'b', side: Position, w: number, h: number,
  data: PIDNodeData, nodeId: string, rotation: number,
) {
  const count = Math.max(1, Math.min(4, n));
  return Array.from({ length: count }, (_, i) => {
    const pid = portId(prefix, i);
    // Only `plug` is authored. Whether a port is an instrument tapping is
    // something the port works out from what is on it.
    if (portKind(data, pid) === 'plug') return null;
    return (
      <TurnedPort
        key={pid}
        id={pid}
        nodeId={nodeId}
        side={side}
        along={(w * (i + 1)) / (count + 1)}
        w={w} h={h}
        rotation={rotation}
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
  // React Flow measures a node's handles once, when it mounts. Adding a port
  // afterwards leaves the new one absent from `handleBounds`, and every edge on
  // this node falls back to the node's own centre -- which is why lines to a
  // multi-port tank all bundled at the middle of its top instead of landing on
  // the ports they were drawn to. This is the documented way to tell it to
  // measure again.
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = `${options?.portsTop ?? 1}/${options?.portsBottom ?? 1}/` +
    Object.entries((data as unknown as PIDNodeData).ports ?? {})
      .map(([k, v]) => `${k}:${v.kind ?? 'flow'}`).sort().join(',');
  useEffect(() => { updateNodeInternals(id); }, [id, portSignature, updateNodeInternals]);

  const assigned = useNodeFluid(id);
  const species = speciesById(assigned?.species ?? undefined);
  const fluidColor = color ?? (species ? colorForSpecies(species.id) : UNSET_COLOR);
  const isInjector = componentType === 'INJECTOR';
  // The box each symbol occupies once turned, so the tag stays under it.
  const quarter = (rotation ?? 0) % 180 === 90;
  const injBoxH = quarter ? INJ_W : INJ_H;
  const tankBoxH = quarter ? TANK_W : TANK_H;

  if (isInjector) {
    return (
      <Frame
        w={INJ_W} h={INJ_H} rotation={rotation}
        extra={<>
          <TurnedPort nodeId={id} id="t" side={Position.Top}    w={INJ_W} h={INJ_H} rotation={rotation ?? 0} />
          <TurnedPort nodeId={id} id="b" side={Position.Bottom} w={INJ_W} h={INJ_H} rotation={rotation ?? 0} />
          <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: injBoxH + 2 }} />
        </>}
      >

        <svg width={INJ_W} height={INJ_H} viewBox={`0 0 ${INJ_W} ${INJ_H}`}>
          <rect x="10" y="6" width="40" height="22" rx="2"
            fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
          <Upright rotation={rotation} cx={INJ_W / 2} cy={INJ_H / 2}>
            <text x="30" y="21" textAnchor="middle" fontSize="8" fill="#e2e8f0" fontFamily="monospace">INJ</text>
          </Upright>
          <polygon points="10,28 50,28 38,88 22,88"
            fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
          <line x1="22" y1="88" x2="38" y2="88" stroke={stroke} strokeWidth={2} />
        </svg>

      </Frame>
    );
  }

  return (
    <Frame
      w={TANK_W} h={TANK_H} rotation={rotation}
      extra={<>
        {endPorts(Number(options?.portsTop ?? 1), 't', Position.Top, TANK_W, TANK_H, data as unknown as PIDNodeData, id, rotation ?? 0)}
        {endPorts(Number(options?.portsBottom ?? 1), 'b', Position.Bottom, TANK_W, TANK_H, data as unknown as PIDNodeData, id, rotation ?? 0)}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: tankBoxH + 2 }} />
      </>}
    >

      <svg width={TANK_W} height={TANK_H} viewBox={`0 0 ${TANK_W} ${TANK_H}`}>
        {/* One silhouette, filled once.
            It used to be three shapes with their own fills -- a tinted barrel
            between two slate heads -- so a tank read as a striped thing rather
            than a vessel, and only the middle of it took the fluid colour.
            Filling all three instead would band at the seams, because the
            heads overlap the barrel and the tint is translucent. */}
        <path d="M6,14 A24,9 0 0 1 54,14 L54,84 A24,9 0 0 1 6,84 Z"
          fill={fluidColor + '22'} stroke={stroke}
          strokeWidth={selected ? 2.5 : 1.5} strokeLinejoin="round" />
        {/* Where each dished head meets the barrel. */}
        <path d="M6,14 A24,9 0 0 0 54,14" fill="none" stroke={stroke}
          strokeWidth={1.1} opacity={0.75} />
        <path d="M6,84 A24,9 0 0 1 54,84" fill="none" stroke={stroke}
          strokeWidth={1.1} opacity={0.75} />
        <Upright rotation={rotation} cx={TANK_W / 2} cy={TANK_H / 2}>
          <text x="30" y="52" textAnchor="middle" fontSize="10" fill={fluidColor}
            fontFamily="monospace" fontWeight="bold">
            {species?.short ?? 'TANK'}
          </text>
        </Upright>
      </svg>

    </Frame>
  );
}
