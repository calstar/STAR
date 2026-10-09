/**
 * What the stand is doing, drawn on top of the drawing.
 *
 * The drawing is pid-designer's own canvas (`@pid/DrawingView`); this is the
 * only part of the schematic feed-twin owns. Three things, each placed by the
 * drawing rather than by guesswork:
 *
 * - a reading above each instrument and vessel -- pressure on a transducer,
 *   gauge, tank, bottle, dewar or the engine, temperature on an RTD or
 *   thermocouple. Not on every symbol: thirty-odd valves and disconnects each
 *   reading "0" buried the transducers, a reading over a valve does not say
 *   which side it is, and an RTD labelled with a pressure read as a gauge;
 * - a ring round each valve the console drives, green open and red shut, and a
 *   dashed one outside it when the operator holds it by hand. A ring, not a
 *   repaint: the symbol already draws its fail state, and a normally-open
 *   valve that is shut must not look like a normally-closed one;
 * - a dash moving along each line that is flowing, along the line as it is
 *   actually drawn, its speed set by the mass flow and its direction by the
 *   sign. Direction of flow is hard to read from a number, and it is the first
 *   thing anyone asks of a schematic.
 */

import { ViewportPortal, useNodes } from '@xyflow/react';
import type { Node } from '@xyflow/react';
import { useDrawnRoutes } from '@pid/edgeGeometry';
import type { Pt } from '@pid/route';
import type { Frame } from '../api';
import { fixed } from '../api';
import { dashPeriod, isFlowing } from '../lib/schematic';

/** What reads or holds a pressure: these carry one. */
const PRESSURE = new Set(['PT', 'PG', 'TANK', 'KBOTTLE', 'DEWAR', 'ENGINE']);
/** What reads a temperature. */
const TEMPERATURE = new Set(['RTD', 'TC']);

interface Props {
  frame: Frame | null;
  /** Every line on the drawing, by id. */
  lines: readonly string[];
  /** The valves the console drives. */
  valves: ReadonlySet<string>;
  /** Valves held by hand, overriding the sequence. */
  held: ReadonlySet<string>;
  /** The symbol open in the P&ID tab's panel: ringed, so it is found. */
  focus?: string | null;
}

export function LiveLayer({ frame, lines, valves, held, focus = null }: Props) {
  const nodes = useNodes();
  const routes = useDrawnRoutes(lines);
  if (!frame) return null;

  const shown = nodes.filter((n) => !n.hidden && n.measured?.width && n.measured?.height);
  const flowing = [...routes].filter(([id]) => isFlowing(frame.flow_kg_s[id] ?? 0));

  return (
    <ViewportPortal>
      <svg
        style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 1 }}
        width={1}
        height={1}
      >
        {flowing.map(([id, pts]) => (
          <FlowDash key={id} pts={pts} flow={frame.flow_kg_s[id]} />
        ))}
        {shown
          .filter((n) => valves.has(n.id))
          .map((n) => (
            <ValveRing key={n.id} node={n} open={frame.open[n.id] ?? false} held={held.has(n.id)} />
          ))}
        {shown
          .filter((n) => n.id === focus)
          .map((n) => (
            <rect
              key="focus"
              x={n.position.x - 12}
              y={n.position.y - 12}
              width={n.measured!.width! + 24}
              height={n.measured!.height! + 24}
              rx={12}
              fill="none"
              stroke="#60A5FA"
              strokeWidth={2.5}
            />
          ))}
      </svg>
      {shown.map((n) => {
        const type = (n.data as { componentType?: string }).componentType ?? n.type ?? '';
        const kelvin = TEMPERATURE.has(type) ? frame.temperature_K?.[n.id] : undefined;
        const psi = PRESSURE.has(type) ? (frame.pressure_psi[n.id] ?? frame.node_psi[n.id]) : undefined;
        if (psi === undefined && kelvin === undefined) return null;
        const x = n.position.x + n.measured!.width! / 2;
        const y = n.position.y - 3;
        return (
          <div
            key={n.id}
            className="pointer-events-none absolute rounded bg-[var(--color-bg-primary)]/80 px-1 font-mono text-[11px] leading-tight text-[var(--color-text-primary)] tabular-nums"
            style={{ transform: `translate(${x}px, ${y}px) translate(-50%, -100%)`, zIndex: 1 }}
          >
            {kelvin !== undefined ? `${fixed(kelvin, 0)} K` : fixed(psi ?? 0, 0)}
          </div>
        );
      })}
    </ViewportPortal>
  );
}

function FlowDash({ pts, flow }: { pts: Pt[]; flow: number }) {
  // A route runs source to target; flow against it runs the dash backwards.
  const run = flow >= 0 ? pts : [...pts].reverse();
  const d = run.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
  return (
    <path
      d={d}
      fill="none"
      stroke="var(--color-text-primary)"
      strokeWidth={2}
      strokeDasharray="5 19"
      strokeLinecap="round"
      opacity={0.9}
      style={{ animation: `pid-flow ${dashPeriod(flow)}s linear infinite` }}
    />
  );
}

function ValveRing({ node, open, held }: { node: Node; open: boolean; held: boolean }) {
  const w = node.measured!.width!;
  const h = node.measured!.height!;
  const { x, y } = node.position;
  return (
    <g>
      <rect
        x={x - 4}
        y={y - 4}
        width={w + 8}
        height={h + 8}
        rx={6}
        fill="none"
        stroke={open ? 'var(--ok)' : 'var(--bad)'}
        strokeWidth={1.5}
      />
      {/* The state is the operator's, not the sequence's, and nothing else on
          the drawing would say so. */}
      {held && (
        <rect
          x={x - 8}
          y={y - 8}
          width={w + 16}
          height={h + 16}
          rx={9}
          fill="none"
          stroke="var(--accent)"
          strokeWidth={1.25}
          strokeDasharray="2 3"
        />
      )}
    </g>
  );
}
