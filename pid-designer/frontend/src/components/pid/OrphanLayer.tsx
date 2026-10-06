import { ViewportPortal, type Edge, type Node } from '@xyflow/react';
import { centreOf } from './attach';
import { orphanedLines } from './checks';
import { unmeasuredEnd } from './unmeasured';
import type { Pt } from './route';

/** Where a broken line is drawn: from the end still on a port, to the symbol whose port is gone. */
export interface OrphanPath {
  edgeId: string;
  from: Pt;
  to: Pt;
}

/**
 * The lines on ports that no longer exist (`orphanedLines`), as they can be
 * drawn: React Flow will not draw a line it cannot place, so a broken one was
 * saved, flagged and nowhere on screen. Each runs straight from the end that
 * is still on a port -- or that symbol's centre -- to the centre of the
 * symbol whose port is gone. Only lines whose two ends are both shown.
 */
export function orphanPaths(nodes: Node[], edges: Edge[]): OrphanPath[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const out: OrphanPath[] = [];
  for (const o of orphanedLines(nodes, edges)) {
    const gone = byId.get(o.nodeId);
    const atSource = o.edge.source === o.nodeId;
    const other = byId.get(atSource ? o.edge.target : o.edge.source);
    if (!gone || !other || gone.hidden || other.hidden) continue;
    const otherHandle = atSource ? o.edge.targetHandle : o.edge.sourceHandle;
    const from = unmeasuredEnd(other, otherHandle) ?? centreOf(other);
    out.push({ edgeId: o.edge.id, from: { x: from.x, y: from.y }, to: centreOf(gone) });
  }
  return out;
}

/**
 * Draws them: red, dashed, with a cross where the port was meant to be.
 * Given `onSelect`, a click on one selects that line, for Delete to remove.
 */
export function OrphanLayer({ nodes, edges, onSelect }: {
  nodes: Node[];
  edges: Edge[];
  onSelect?: (edgeId: string) => void;
}) {
  const paths = orphanPaths(nodes, edges);
  if (paths.length === 0) return null;
  const selected = new Set(edges.filter(e => e.selected).map(e => e.id));
  return (
    <ViewportPortal>
      <svg style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 0 }} width={1} height={1}>
        {paths.map(p => {
          const d = `M ${p.from.x} ${p.from.y} L ${p.to.x} ${p.to.y}`;
          const on = selected.has(p.edgeId);
          return (
            <g key={p.edgeId} data-orphan={p.edgeId}>
              {onSelect && (
                <path d={d} fill="none" stroke="transparent" strokeWidth={10}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={e => { e.stopPropagation(); onSelect(p.edgeId); }} />
              )}
              <path d={d} fill="none" stroke="var(--color-danger)" strokeWidth={on ? 2.5 : 1.5} strokeDasharray="6 4" />
              <path d={`M ${p.to.x - 5} ${p.to.y - 5} L ${p.to.x + 5} ${p.to.y + 5} M ${p.to.x + 5} ${p.to.y - 5} L ${p.to.x - 5} ${p.to.y + 5}`}
                stroke="var(--color-danger)" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}
