import { ViewportPortal, type Edge, type Node } from '@xyflow/react';
import { leaderTarget } from './attach';
import type { PIDNodeData } from './types';

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
 * Faint and behind everything, so it never reads as flow.
 */
export function AttachmentLayer({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const leaders: { id: string; x1: number; y1: number; x2: number; y2: number }[] = [];

  for (const n of nodes) {
    const host = (n.data as unknown as PIDNodeData)?.attachedTo;
    if (!host) continue;
    const to = leaderTarget(host, nodes, edges);
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
