import { cloneElement, useMemo } from 'react';
import type { ReactElement } from 'react';
import { ViewportPortal, type Edge, type Node } from '@xyflow/react';
import { centreOf, lineRoutes } from './attach';
import type { ClipData } from './attach';
import { drawnCorners, useDrawnRoutes } from './edgeGeometry';
import { pointAt } from './route';
import type { Pt } from './route';

/**
 * The leaders from instruments to what they measure.
 *
 * Drawn in one SVG in viewport space rather than inside each sensor, because a
 * leader spans two elements and belongs to neither.
 *
 * It starts at the *edge* of the instrument nearest its host, not at the
 * centre: a line drawn from the middle crosses the symbol and its text, which
 * looked like a pipe running through the probe.
 *
 * It lands where the probe is clipped: the centre of a component, or the
 * point on a line as it is drawn -- round its bends, not on the chord between
 * its two ends -- that the probe was dropped on.
 *
 * Only what is on the page in view. This is handed the page's view, in which
 * everything on other pages is still present and only marked `hidden`, so a
 * probe that is hidden, or whose host is, is skipped -- as `VentLayer` skips
 * vents. Otherwise another page's leaders floated over this one, landing
 * their dots on this page's pipes, and were baked into its exported image.
 *
 * Faint and behind everything, so it never reads as flow.
 *
 * No hooks, so it is a plain function of what it is given; `DrawnRoutes`
 * below is what keeps it in step with the lines as they draw.
 */
export interface AttachmentLayerProps {
  nodes: Node[];
  edges: Edge[];
  /** The host lines' drawn corners. Read from `drawnCorners` when not given. */
  routes?: ReadonlyMap<string, Pt[]>;
}

export function AttachmentLayer({ nodes, edges, routes }: AttachmentLayerProps) {
  const leaders: { id: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const edgeById = new Map(edges.map(e => [e.id, e]));
  // Only the lines something is clipped to are worth routing.
  const clipped = new Set(nodes.map(n => (n.data as ClipData)?.attachedTo).filter(Boolean));
  const drawn = lineRoutes(nodes, edges.filter(e => clipped.has(e.id)), routes ?? drawnCorners());

  for (const n of nodes) {
    const { attachedTo: host, attachedAt } = (n.data ?? {}) as ClipData;
    if (!host || n.hidden) continue;
    let to: Pt | null = null;
    const hostNode = nodeById.get(host);
    if (hostNode) {
      if (hostNode.hidden) continue;
      to = centreOf(hostNode);
    } else {
      const hostEdge = edgeById.get(host);
      if (!hostEdge || hostEdge.hidden) continue;
      const pts = drawn.get(host);
      to = pts ? pointAt(pts, attachedAt ?? 0.5)?.point ?? null : null;
    }
    if (!to) continue;
    const w = n.measured?.width ?? 60;
    const h = n.measured?.height ?? 60;
    const cx = n.position.x + w / 2;
    const cy = n.position.y + h / 2;
    // Step out from the centre along the line to the host, by the symbol's
    // radius, so the leader begins where the circle ends.
    const dx = to.x - cx;
    const dy = to.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) continue;
    const r = Math.min(w, h) / 2;
    leaders.push({
      id: n.id,
      x1: cx + (dx / dist) * r,
      y1: cy + (dy / dist) * r,
      x2: to.x,
      y2: to.y,
    });
  }

  if (leaders.length === 0) return null;

  return (
    <ViewportPortal>
      <svg
        style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 0 }}
        width={1} height={1}
      >
        {leaders.map(l => (
          <g key={l.id}>
            <line
              x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
              stroke="var(--color-text-secondary)" strokeWidth={1.2} strokeDasharray="2 3"
            />
            {/* Where it lands, not just that it's connected somewhere --
                the dashed line alone reads as "faint pipe" until something
                marks the actual point of contact. */}
            <circle cx={l.x2} cy={l.y2} r={2.5} fill="var(--color-text-secondary)" />
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}

/**
 * Keeps a leader on its line while the line moves.
 *
 * Each line routes itself inside its own render and publishes that route
 * after the render commits; how it is then drawn -- moved a grid step off a
 * line it would lie on (tracks.ts) -- is worked out from every line's route
 * together, and can change when some other line moves. The leaders are drawn
 * in the same render as the lines, so reading the routes then got the ones
 * from the render before: a symbol dragged and let go left every leader on
 * its lines where the line had been one step earlier. And a line can move
 * without the drawing changing at all -- a turned symbol's ports are measured
 * a moment after the turn, and a neighbour moving can move where it is drawn.
 *
 * So this wraps the layer and hands it the drawn routes of just the lines
 * that have probes on them (`useDrawnRoutes`), and draws it again whenever
 * one of those, and only one of those, is drawn somewhere new.
 */
export function DrawnRoutes({ children }: { children: ReactElement<AttachmentLayerProps> }) {
  const { nodes, edges } = children.props;
  const ids = useMemo(() => {
    const clipped = new Set<string>();
    for (const n of nodes) {
      const host = (n.data as ClipData)?.attachedTo;
      if (host) clipped.add(host);
    }
    return edges.filter(e => clipped.has(e.id)).map(e => e.id);
  }, [nodes, edges]);
  const routes = useDrawnRoutes(ids);
  return cloneElement(children, { routes });
}
