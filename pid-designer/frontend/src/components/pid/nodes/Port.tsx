import { Handle, Position, type HandleProps } from '@xyflow/react';

/**
 * A port on a P&ID symbol.
 *
 * Every port is declared `type="source"`, and that is the whole point of this
 * file rather than a bare `<Handle>`.
 *
 * A pipe has no direction on a drawing -- a tank's top port feeds a vent line
 * as readily as it accepts a fill line -- so the canvas runs in
 * `ConnectionMode.Loose`, where any port may connect to any other. Loose mode
 * relaxes two of the three places the handle type is consulted, and not the
 * third: `getEdgePosition` resolves an edge's *target* end against
 * `handleBounds.target ∪ handleBounds.source`, but its *source* end against
 * `handleBounds.source` alone.
 *
 * So when a drag starts on a `target` port and ends on another `target` port,
 * React Flow builds the edge with the port you dropped on as its `source`,
 * fails to find that id among the source handles, and returns null. The edge is
 * added to state and autosaved, and never draws. It is not a refused
 * connection -- it is an invisible one, which is worse, because the graph a
 * reader (or feed-twin) parses then has a branch nobody can see.
 *
 * Declaring every port a source removes the failing quadrant outright: no edge
 * can ever land a target-typed handle in the source slot, because there are no
 * target-typed handles. Loose mode covers the other end.
 */
export function Port({
  id,
  position,
  style,
  kind = 'flow',
  ...rest
}: { id: string; position: Position; kind?: 'flow' | 'instrument' } & Omit<HandleProps, 'type' | 'position' | 'id'> & {
  style?: React.CSSProperties;
}) {
  // An instrument tapping is drawn hollow and small: it is real hardware, but
  // it carries no flow, and a reader should not mistake it for a feed.
  const look = kind === 'instrument'
    ? { background: 'transparent', border: '1.5px solid #64748b', width: 5, height: 5 }
    : { background: '#94a3b8' };
  return (
    <Handle
      type="source"
      id={id}
      position={position}
      style={{ ...look, ...style }}
      {...rest}
    />
  );
}
