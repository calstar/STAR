import { ViewportPortal, type Edge, type Node } from '@xyflow/react';
import { findVents } from './vents';

/**
 * The vent arrows.
 *
 * Drawn in viewport space next to each venting valve rather than inside the
 * valve symbol, because whether a valve vents is a fact about the *graph* -- it
 * changes the moment somebody draws a line to its open side -- and a symbol
 * that had to be told would be one more thing to keep in step.
 *
 * The conventional open-to-atmosphere mark: a short stub and an open triangle.
 */
export function VentLayer({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) {
  const vents = findVents(nodes, edges);
  if (vents.length === 0) return null;

  const marks = vents.flatMap(v => {
    const n = nodes.find(x => x.id === v.nodeId);
    if (!n || n.hidden) return [];
    const w = n.measured?.width ?? 60;
    const h = n.measured?.height ?? 60;
    // Valve ports sit at the left and right edges, vertically centred.
    const right = v.handle === 'r';
    const x = n.position.x + (right ? w : 0);
    const y = n.position.y + h / 2;
    const dir = right ? 1 : -1;
    return [{ id: v.nodeId, x, y, dir }];
  });

  return (
    <ViewportPortal>
      <svg
        style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 0 }}
        width={1} height={1}
      >
        {marks.map(m => (
          <g key={m.id} stroke="#94a3b8" strokeWidth={1.5} fill="none">
            <line x1={m.x} y1={m.y} x2={m.x + 14 * m.dir} y2={m.y} />
            <polyline points={`${m.x + 14 * m.dir},${m.y - 6} ${m.x + 24 * m.dir},${m.y} ${m.x + 14 * m.dir},${m.y + 6}`} />
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
}
