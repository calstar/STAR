import { Position, ViewportPortal, type Edge, type Node } from '@xyflow/react';
import { turnPlacement } from './route';
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
    // Off the port that is actually open, which means asking where rotation
    // put it. This used to assume "left and right edges, vertically centred"
    // and drew the arrow out of the side of a turned valve, where there is no
    // port -- a mark for a vent that appeared to belong to nothing.
    const rotation = (n.data as { rotation?: number })?.rotation ?? 0;
    const quarter = Math.round(((rotation % 360) + 360) % 360 / 90) % 2 === 1;
    const bw = n.measured?.width ?? 60;
    const bh = n.measured?.height ?? 60;
    // `measured` is the turned box; `turnPlacement` works in the unturned one.
    const w = quarter ? bh : bw;
    const h = quarter ? bw : bh;
    const placed = turnPlacement(
      v.handle === 'r' ? Position.Right : Position.Left, h / 2, w, h, rotation);

    let x = n.position.x, y = n.position.y, dx = 0, dy = 0;
    if (placed.side === Position.Right)       { x += bw; y += placed.along; dx = 1; }
    else if (placed.side === Position.Left)   {          y += placed.along; dx = -1; }
    else if (placed.side === Position.Bottom) { x += placed.along; y += bh;  dy = 1; }
    else                                      { x += placed.along;          dy = -1; }
    return [{ id: v.nodeId, x, y, dx, dy }];
  });

  return (
    <ViewportPortal>
      <svg
        style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', zIndex: 0 }}
        width={1} height={1}
      >
        {marks.map(m => {
          // Along the way the port points, with the triangle opening across it.
          const px = -m.dy, py = m.dx;
          const sx = m.x + 14 * m.dx, sy = m.y + 14 * m.dy;
          const tx = m.x + 24 * m.dx, ty = m.y + 24 * m.dy;
          return (
            <g key={m.id} stroke="#94a3b8" strokeWidth={1.5} fill="none">
              <line x1={m.x} y1={m.y} x2={sx} y2={sy} />
              <polyline points={`${sx + 6 * px},${sy + 6 * py} ${tx},${ty} ${sx - 6 * px},${sy - 6 * py}`} />
            </g>
          );
        })}
      </svg>
    </ViewportPortal>
  );
}
