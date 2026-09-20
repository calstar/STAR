import { useState } from 'react';
import { Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import { useNodeFluid } from '../FluidContext';
import { colorForSpecies } from '../fluids';
import { useBranchDrag } from '../BranchDrag';
import { useReadOnly } from '@stardesign-ui';
import { J_HALF } from '../junctions';

/**
 * A branch point: the tee, as the drawing says it.
 *
 * Small on purpose -- it is a point in a run, not a component -- but it is
 * still a thing people select, move and delete, so it has to behave like one.
 *
 * **The dot moves; the ring connects.** A tee is ten pixels across and its
 * four ports were ten pixels each, on its four faces, so their union covered
 * the whole of what you could see. Pressing on the dot started a new line;
 * moving the tee meant finding an invisible halo around it. That inversion
 * was most of what made tees feel broken. The ports are still there -- lines
 * have to end on something -- but they no longer take the pointer. Press the
 * dot and you drag it, which slides it along its run (see junctions.ts);
 * pull the ring that appears around it and you draw a new line out of it.
 *
 * A tee with one line on it is an **open end**: a run somebody started and
 * has not finished, drawn hollow so it reads as unfinished. Pull its ring to
 * carry the run on.
 */
export function JunctionNode({ id, selected }: NodeProps) {
  // A junction is a point *in* a run, so it is drawn in the run's own colour.
  // A grey dot on an orange line read as something foreign sitting on the
  // pipe rather than a tee in it.
  const fluid = useNodeFluid(id);
  const tint = fluid?.species ? colorForSpecies(fluid.species) : 'var(--color-text-secondary)';
  const readOnly = useReadOnly();
  const { begin } = useBranchDrag();
  const { getInternalNode } = useReactFlow();
  const [hover, setHover] = useState(false);
  const degree = useStore(s => {
    let n = 0;
    for (const e of s.edges) if (e.source === id || e.target === id) n++;
    return n;
  });
  const open = degree <= 1;

  // Faces, not handles: they anchor the lines and take no pointer.
  const faceStyle = {
    width: 10, height: 10, background: 'transparent', border: 'none',
    pointerEvents: 'none' as const, boxShadow: 'none',
  };
  const ink = selected ? 'var(--color-text-primary)' : tint;

  return (
    <div
      title={open ? 'Open end — pull the ring to carry the line on' : 'Tee — drag to slide it along its run; pull the ring to branch'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: 10, height: 10, borderRadius: '50%', position: 'relative',
        cursor: readOnly ? 'default' : 'grab',
        background: open ? 'var(--color-bg-primary)' : ink,
        border: `2px solid ${open ? ink : 'var(--color-bg-secondary)'}`,
        boxShadow: open ? 'none' : `0 0 0 2px ${ink}`,
      }}
    >
      {/* Ten pixels is a hard thing to hit. This reaches past the dot without
          drawing anything, so aiming at a junction is aiming at a target the
          size of a symbol. */}
      <div style={{ position: 'absolute', left: -7, top: -7, width: 24, height: 24, borderRadius: '50%' }} />

      {/* The ring: pull it to draw a line out of the tee.

          An SVG stroke, not a box. It was a 24 px div over the dot, and a
          div takes the pointer over its whole square -- so once somebody
          had hovered, pressing on the dot itself started a pull instead of
          a drag, which is the inversion this ring exists to remove. With
          `pointer-events: stroke` only the ring itself is pressable; the
          dot underneath still drags. `nodrag` keeps the press from moving
          the tee as well. */}
      {!readOnly && (hover || selected) && (
        <svg
          width={30} height={30} viewBox="0 0 30 30"
          style={{ position: 'absolute', left: -12, top: -12, overflow: 'visible', pointerEvents: 'none' }}
        >
          <circle cx={15} cy={15} r={10.5} fill="none" stroke={ink} strokeWidth={1.5} strokeDasharray="3 2.5" />
          <circle
            className="nodrag"
            cx={15} cy={15} r={10.5} fill="none" stroke="transparent" strokeWidth={7}
            style={{ pointerEvents: 'stroke', cursor: 'crosshair' }}
            onPointerDown={e => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              const pos = getInternalNode(id)?.internals.positionAbsolute;
              if (!pos) return;
              begin({ kind: 'node', nodeId: id, at: { x: pos.x + J_HALF, y: pos.y + J_HALF } }, e);
            }}
          >
            <title>Pull to draw a line from here</title>
          </circle>
        </svg>
      )}

      <Port position={Position.Top}    id="t" className="pid-junction-face" style={faceStyle} />
      <Port position={Position.Left}   id="l" className="pid-junction-face" style={faceStyle} />
      <Port position={Position.Bottom} id="b" className="pid-junction-face" style={faceStyle} />
      <Port position={Position.Right}  id="r" className="pid-junction-face" style={faceStyle} />
    </div>
  );
}
