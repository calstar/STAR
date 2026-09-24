import { useEffect, useRef, useState } from 'react';
import { useReactFlow, useStoreApi } from '@xyflow/react';
import type { ConnectionLineComponentProps } from '@xyflow/react';
import { cancelFrame, nextFrame, previewMarks, useBranchDrag } from './BranchDrag';
import { reconnectMoving, resolveDrop } from './drop';
import type { DropScene, DropSource } from './drop';
import { pathPoints, pointsToPath, routeOrthogonal } from './route';
import type { Pt } from './route';
import { previewer } from './preview';
import type { PreviewShape } from './preview';

/**
 * The line a port drag will draw, while it is being dragged.
 *
 * React Flow's own rubber band is a curve from the port to the pointer, and
 * letting go committed something else altogether: an orthogonal route with
 * stubs and detours, a tee into a line, an open end, or -- over the symbol's
 * own body, or too short -- nothing. This draws what will be committed: the
 * drop the designer's `onConnectEnd` (or React Flow's own `onConnect`, right
 * on a free port) will make, resolved by drop.ts from where the pointer is
 * and what is under it, and routed as the canvas routes the line it makes
 * (preview.ts). A drop that makes nothing is drawn faded, as the bare pull.
 *
 * The same component draws a line's end being carried to another port
 * (React Flow runs that as a drag out of the end that stays), resolved as the
 * carry it is.
 *
 * Resolved once an animation frame, whatever rate the pointer reports at;
 * between frames the last answer stands. The drawing is read once per drag,
 * since nothing in it moves until the drag is let go.
 */
export function ConnectionLine(props: ConnectionLineComponentProps) {
  const { fromX, fromY, fromPosition, toX, toY, toPosition, toHandle, pointer } = props;
  const { drop } = useBranchDrag();
  const store = useStoreApi();
  const { screenToFlowPosition } = useReactFlow();
  const [shape, setShape] = useState<PreviewShape | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const drawing = useRef<{ scene: DropScene; preview: ReturnType<typeof previewer> } | null>(null);
  const frame = useRef(0);

  const toKey = toHandle ? `${toHandle.nodeId}\u0000${toHandle.id ?? ''}` : '';
  useEffect(() => {
    if (!drop || frame.current) return;
    frame.current = nextFrame(() => {
      frame.current = 0;
      const p = latest.current;
      if (!p.fromHandle?.id) return;
      const box = store.getState().domNode?.getBoundingClientRect();
      const client = { x: p.pointer.x + (box?.left ?? 0), y: p.pointer.y + (box?.top ?? 0) };
      const at = screenToFlowPosition(client, { snapToGrid: false });
      if (!drawing.current) { const scene = drop.scene(); drawing.current = { scene, preview: previewer(scene) }; }
      const { scene: sc, preview } = drawing.current;
      const carried = drop.carrying();
      const line = carried ? sc.edges.find(e => e.id === carried) : undefined;
      const stays = { nodeId: p.fromNode.id, handle: p.fromHandle.id };
      const source: DropSource = line
        ? { kind: 'reconnect', edgeId: line.id, moving: reconnectMoving(line, p.fromHandle.type, stays) }
        : { kind: 'port', nodeId: p.fromNode.id, handle: p.fromHandle.id };
      const near = p.toHandle ? { nodeId: p.toHandle.nodeId, id: p.toHandle.id } : null;
      const plan = resolveDrop(source, at, drop.under(client, at, sc, near), sc);
      setShape(preview(plan, { from: { x: p.fromX, y: p.fromY }, to: at }));
    });
  }, [drop, pointer.x, pointer.y, toKey, store, screenToFlowPosition]);
  // Unmounting drops the frame still to come, and forgets it: React's
  // StrictMode runs this cleanup straight after the first mount and then
  // mounts again with the same refs, and a remembered id for a cancelled
  // frame would read as "a frame is on its way" to the effect above, which
  // would then never ask for one again.
  useEffect(() => () => { cancelFrame(frame.current); frame.current = 0; }, []);

  // Before the first frame, and with no designer to ask: the plain route
  // from the port to the pointer, leaving the port the way it faces.
  const points: Pt[] = shape?.points ?? pathPoints(routeOrthogonal(
    { x: fromX, y: fromY, side: fromPosition },
    { x: toX, y: toY, side: toPosition },
  ).d);
  const cancel = shape?.cancel ?? false;
  return (
    <g style={{ opacity: cancel ? 0.35 : 1 }}>
      <path
        d={pointsToPath(points)} fill="none" className="react-flow__connection-path"
        style={{ stroke: 'var(--color-text-secondary)', strokeWidth: 2, strokeDasharray: '6 4' }}
      />
      {previewMarks(shape, points, 'var(--color-text-secondary)')}
    </g>
  );
}
