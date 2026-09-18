import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import { useNodeFluid } from '../FluidContext';
import { colorForSpecies } from '../fluids';

/**
 * A branch point: the tee, as the drawing says it.
 *
 * Small on purpose -- it is a point in a run, not a component -- but it is
 * still a thing people select, move and delete, so it has to behave like one.
 * It carried `nodrag`, which in ReactFlow turns off the pointer handling that
 * *selects* a node as well as the part that moves it: the dot could not be
 * picked at all, and pressing Delete over it did nothing.
 */
export function JunctionNode({ id, selected }: NodeProps) {
  // A junction is a point *in* a run, so it is drawn in the run's own colour.
  // A grey dot on an orange line read as something foreign sitting on the
  // pipe rather than a tee in it.
  const fluid = useNodeFluid(id);
  const tint = fluid?.species ? colorForSpecies(fluid.species) : 'var(--color-text-secondary)';
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
        background: selected ? 'var(--color-text-primary)' : tint,
        border: '2px solid var(--color-bg-secondary)',
        boxShadow: `0 0 0 2px ${selected ? 'var(--color-text-primary)' : tint}`,
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
