import { ViewportPortal, type Edge, type Node } from '@xyflow/react';
import { leaderTarget } from './attach';
import type { PIDNodeData } from './types';

/**
 * The leaders from instruments to what they measure.
 *
 * Drawn in one SVG in viewport space rather than as part of each sensor,
 * because a leader spans two elements and belongs to neither: an instrument
 * clipped to a line has no idea where that line is, and the line has no idea
 * anything is watching it.
 *
 * Deliberately faint and behind everything. It is a reminder of what a probe
 * is attached to, not a pipe, and a reader should never mistake one for flow.
 */
export function AttachmentLayer({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const leaders: { id: string; x1: number; y1: number; x2: number; y2: number }[] = [];

  for (const n of nodes) {
    const host = (n.data as unknown as PIDNodeData)?.attachedTo;
    if (!host) continue;
    const to = leaderTarget(host, nodes, edges);
    if (!to) continue;
    leaders.push({
      id: n.id,
      x1: n.position.x + (n.measured?.width ?? 60) / 2,
      y1: n.position.y + (n.measured?.height ?? 60) / 2,
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
          <line
            key={l.id}
            x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
            stroke="#475569" strokeWidth={1} strokeDasharray="2 3"
          />
        ))}
      </svg>
    </ViewportPortal>
  );
}
