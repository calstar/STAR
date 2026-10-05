import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { useEffect } from 'react';
import { Frame, TurnedPort } from './Frame';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { VALVE_BANK_MAX, portIds, portKind } from '../ports';

/**
 * A 5/2 solenoid valve manifold: a base with one supply port, and a 5/2
 * solenoid valve on a station for each outlet.
 *
 * One block rather than a manifold and a row of solenoid valves, because that
 * is the hardware: the valves bolt onto a common base that carries the supply
 * through it, and the number of stations is what is bought. Each station is
 * drawn as the ISO 1219 symbol -- two envelopes, straight-through and
 * crossed, with the solenoid on its end -- and its outlet leaves from the top.
 * What leaves an outlet is a dotted line to whatever it drives, not a flow
 * line: see signals.ts.
 *
 * Everything is on the 10 px grid: stations every `PITCH`, each outlet in the
 * middle of its station, the supply level with the bore, so a line into any
 * port of a block standing on the grid draws straight.
 */
const PITCH = 40;
const PAD = 10;
export const BANK_H = 60;
/** Where the supply bore runs, down from the top: the supply port is level with it. */
const BORE_Y = 50;

const clampOutlets = (n: number) => Math.max(1, Math.min(VALVE_BANK_MAX, Math.round(n) || 1));

/** How many outlets the block's options ask for, from 1 to `VALVE_BANK_MAX`. */
export const bankOutlets = (options?: Record<string, string>) => clampOutlets(Number(options?.outlets ?? 4));

export const bankWidth = (outlets: number) => clampOutlets(outlets) * PITCH + 2 * PAD;

/** The ids of a block's ports: the supply, then the outlets. */
export const bankPortIds = (outlets: number) => ['in', ...portIds('p', clampOutlets(outlets))];

/** Where a port is drawn, unturned: its side and how far along it from the top-left. */
export function bankPort(outlets: number, id: string): { side: Position; along: number } | null {
  if (id === 'in') return { side: Position.Left, along: BORE_Y };
  const m = /^p(\d*)$/.exec(id);
  if (!m) return null;
  const i = m[1] ? Number(m[1]) - 1 : 0;
  if (i < 0 || i >= clampOutlets(outlets)) return null;
  return { side: Position.Top, along: PAD + PITCH / 2 + i * PITCH };
}

/** One station's valve: two envelopes, the solenoid on the right-hand end. */
function Station({ cx, stroke }: { cx: number; stroke: string }) {
  const top = 12, bottom = 36, half = 11;
  const l = cx - half, r = cx + half;
  return (
    <g stroke={stroke} fill="none" strokeWidth={1.2}>
      {/* the outlet down to the valve, dotted as its line is (signals.ts),
          and the valve down to the bore */}
      <line x1={cx} y1={0} x2={cx} y2={top} strokeDasharray="1.5 3" strokeLinecap="round" />
      <line x1={cx} y1={bottom} x2={cx} y2={42} />
      <rect x={l} y={top} width={2 * half} height={bottom - top} fill="var(--color-bg-tertiary)" />
      <line x1={cx} y1={top} x2={cx} y2={bottom} />
      {/* left envelope: straight through */}
      <line x1={l + 4} y1={bottom - 3} x2={l + 4} y2={top + 4} />
      <polyline points={`${l + 2},${top + 7} ${l + 4},${top + 4} ${l + 6},${top + 7}`} />
      <line x1={cx - 4} y1={top + 3} x2={cx - 4} y2={bottom - 4} />
      <polyline points={`${cx - 6},${bottom - 7} ${cx - 4},${bottom - 4} ${cx - 2},${bottom - 7}`} />
      {/* right envelope: crossed */}
      <line x1={cx + 3} y1={bottom - 3} x2={r - 3} y2={top + 3} />
      <line x1={cx + 3} y1={top + 3} x2={r - 3} y2={bottom - 3} />
      {/* the solenoid */}
      <rect x={r} y={top + 6} width={6} height={12} fill="var(--color-bg-tertiary)" />
      <line x1={r} y1={top + 18} x2={r + 6} y2={top + 6} />
    </g>
  );
}

export function ValveBankNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, options, color } = data as unknown as PIDNodeData;
  const stroke = selected ? 'var(--color-text-primary)' : (color ?? 'var(--color-text-secondary)');
  const outlets = bankOutlets(options);
  const W = bankWidth(outlets), H = BANK_H;

  // See ManifoldNode: a changed port count has to ask for a re-measure, or
  // the lines on the new ports fall back to the node's centre.
  const updateNodeInternals = useUpdateNodeInternals();
  const portSignature = `${outlets}/` + Object.entries((data as unknown as PIDNodeData).ports ?? {})
    .map(([k, v]) => `${k}:${v.kind ?? 'flow'}`).sort().join(',');
  useEffect(() => { updateNodeInternals(id); }, [id, portSignature, updateNodeInternals]);

  const quarter = (rotation ?? 0) % 180 === 90;
  const boxH = quarter ? W : H;

  // A plugged port is not drawn, as on a manifold: a blanked station.
  const ports = bankPortIds(outlets).map(pid => {
    if (portKind(data as unknown as PIDNodeData, pid) === 'plug') return null;
    const port = bankPort(outlets, pid)!;
    return <TurnedPort key={pid} nodeId={id} id={pid} side={port.side} along={port.along}
      w={W} h={H} rotation={rotation ?? 0} />;
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
        {/* the base, with the supply bore through it */}
        <rect x="1" y="42" width={W - 2} height={H - 43} rx="2"
          fill="var(--color-bg-tertiary)" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <line x1="4" y1={BORE_Y} x2={W - 4} y2={BORE_Y} stroke={stroke} strokeWidth={1} strokeDasharray="3 3" />
        {Array.from({ length: outlets }, (_, i) => (
          portKind(data as unknown as PIDNodeData, i === 0 ? 'p' : `p${i + 1}`) === 'plug'
            ? null
            : <Station key={i} cx={PAD + PITCH / 2 + i * PITCH} stroke={stroke} />
        ))}
      </svg>
    </Frame>
  );
}
