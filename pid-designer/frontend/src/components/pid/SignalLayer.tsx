import { ViewportPortal, type Edge, type Node } from '@xyflow/react';
import { lineRoutes } from './attach';
import { useDrawnRoutes } from './edgeGeometry';
import { signalLines, signalPaths } from './signals';

/**
 * The dotted lines out of the 5/2 solenoid manifolds' outlets (signals.ts).
 *
 * Drawn in one SVG in viewport space, as the probes' leaders are, since a
 * dotted line belongs to no edge. One on a line follows that line as it is
 * drawn (`useDrawnRoutes`). Given `onSelect`, a dotted line can be clicked --
 * a wide invisible stroke under it takes the click -- and the selected one is
 * drawn heavier, for Delete to take away.
 */
export function SignalLayer({ nodes, edges, selected, onSelect }: {
  nodes: Node[];
  edges: Edge[];
  selected?: { bank: string; port: string } | null;
  onSelect?: (s: { bank: string; port: string }) => void;
}) {
  const ids = signalLines(nodes);
  const drawn = useDrawnRoutes(ids);
  const wanted = new Set(ids);
  const routes = lineRoutes(nodes, edges.filter(e => wanted.has(e.id) && !e.hidden), drawn);
  const paths = signalPaths(nodes, routes);
  if (paths.length === 0) return null;
  return (
    <ViewportPortal>
      <svg style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 0 }} width={1} height={1}>
        {paths.map(p => {
          const on = selected?.bank === p.bank && selected.port === p.port;
          return (
            <g key={`${p.bank}/${p.port}`} data-signal={`${p.bank}/${p.port}`}>
              {onSelect && (
                <path d={p.d} fill="none" stroke="transparent" strokeWidth={10}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={e => { e.stopPropagation(); onSelect({ bank: p.bank, port: p.port }); }} />
              )}
              <path d={p.d} fill="none"
                stroke={on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)'}
                strokeWidth={on ? 2 : 1.3} strokeDasharray="1.5 3" strokeLinecap="round" />
              {p.lands && <circle cx={p.end.x} cy={p.end.y} r={2.2} fill="var(--color-text-secondary)" />}
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}
