import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';

/**
 * A branch point: the tee, as the drawing says it.
 *
 * Small on purpose -- it is a point in a run, not a component -- but it is
 * still a thing people select, move and delete, so it has to behave like one.
 * It carried `nodrag`, which in ReactFlow turns off the pointer handling that
 * *selects* a node as well as the part that moves it: the dot could not be
 * picked at all, and pressing Delete over it did nothing.
 */
export function JunctionNode({ selected }: NodeProps) {
  const handleStyle = {
    width: 10,
    height: 10,
    background: 'transparent',
    border: 'none',
  };

  return (
    <div
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: selected ? '#3b82f6' : '#94a3b8',
        border: '2px solid #0f172a',
        boxShadow: `0 0 0 2px ${selected ? '#3b82f6' : '#475569'}`,
        position: 'relative',
        cursor: 'grab',
      }}
    >
      {/* Ten pixels is a hard thing to hit. This reaches past the dot without
          drawing anything, so aiming at a junction is aiming at a target the
          size of a symbol -- and it sits under the handles, so a drag that
          starts on one still draws a line. */}
      <div style={{
        position: 'absolute', left: -7, top: -7, width: 24, height: 24,
        borderRadius: '50%',
      }} />

      <Port position={Position.Top}   id="t" style={handleStyle} />
      <Port position={Position.Left}  id="l" style={handleStyle} />
      <Port position={Position.Bottom} id="b" style={handleStyle} />
      <Port position={Position.Right}  id="r" style={handleStyle} />
    </div>
  );
}
