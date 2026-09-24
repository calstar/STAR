import { useEffect, useState } from 'react';
import { Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import { useNodeFluid } from '../FluidContext';
import { colorForSpecies } from '../fluids';
import { lineSourceAt, useBranchDrag } from '../BranchDrag';
import { useReadOnly } from '@stardesign-ui';
import { J_HALF } from '../junctions';
import { onScreen } from '../drop';
import { handToLine } from '../lineHit';
import { forgetHover, hoverAt, leaveHover } from '../BranchableEdge';

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
 * **A line nearer the pointer than the tee is the line's.** The halo and the
 * ring reach past the dot so a ten-pixel target can be hit at all, and every
 * node is drawn above every line: they used to reach past the next grid line
 * too, so a press on another pipe one grid step away dragged this tee, or
 * pulled a branch out of it that crossed the pipe that was pressed. Both are
 * now kept inside a grid step at full size, and a press on either that is
 * nearer another line's centreline than this tee's centre goes to that line
 * (`lineSourceAt`) -- a tee's own lines meet at its dot, and do not count.
 * So does everything else the pointer does there: the click after the press
 * is handed to that line (`handToLine`), so it is the line that is picked,
 * painted, configured or given the colour menu, not the tee -- which a
 * Delete would then have removed with its branches -- and the hover dot goes
 * on that line where the press would put its tee.
 *
 * A tee with one line on it is an **open end**: a run somebody started and
 * has not finished, drawn hollow so it reads as unfinished. Pull its ring to
 * carry the run on.
 */

/** How far out the dot is drawn: its own radius and the 2 px ring its shadow draws round it. */
const DOT_R = J_HALF + 2;
/** The halo that makes the dot easier to grab than its size, in screen pixels, and never less on the drawing. */
const HALO = 8;
/** The ring's pull band, across, in screen pixels, and never less on the drawing... */
const RING = 3;
/** ...from just inside the dot's edge, so the whole of the dot drags. */
const RING_INNER = DOT_R - 0.5;
/** Neither reaches further than this on the drawing, so at a low zoom a tee's targets do not cover the ports round it. */
const REACH_MAX = 14;
/** Half-pixel steps, so zooming redraws the tees a handful of times, not on every step of the wheel. */
const half = (v: number) => Math.round(v * 2) / 2;

export const haloRadius = (zoom: number) => Math.min(REACH_MAX, half(onScreen(HALO, HALO, zoom)));
export const ringBand = (zoom: number) =>
  ({ inner: RING_INNER, outer: Math.min(REACH_MAX, half(RING_INNER + onScreen(RING, RING, zoom))) });

/**
 * Where a box `size` across goes, inside the dot, to be centred on it. The
 * dot is ten pixels with a 2 px border and every box here is sized
 * border-box (index.css), so an absolute child is placed from inside the
 * border -- (2, 2) from the dot's corner. Placed from the corner instead, the
 * halo sat two pixels down and to the right, and reached eighteen pixels
 * that way and none the other.
 */
const BORDER = 2;
const inset = (size: number) => J_HALF - BORDER - size / 2;

export function JunctionNode({ id, selected }: NodeProps) {
  // A junction is a point *in* a run, so it is drawn in the run's own colour.
  // A grey dot on an orange line read as something foreign sitting on the
  // pipe rather than a tee in it.
  const fluid = useNodeFluid(id);
  const tint = fluid?.species ? colorForSpecies(fluid.species) : 'var(--color-text-secondary)';
  const readOnly = useReadOnly();
  const { begin, drop } = useBranchDrag();
  const { getInternalNode, getNodes, getEdges, getZoom, screenToFlowPosition } = useReactFlow();
  const [hover, setHover] = useState(false);
  const degree = useStore(s => {
    let n = 0;
    for (const e of s.edges) if (e.source === id || e.target === id) n++;
    return n;
  });
  const halo = useStore(s => haloRadius(s.transform[2]));
  const outer = useStore(s => ringBand(s.transform[2]).outer);
  const open = degree <= 1;

  /** The tee's centre on the drawing, and the line a press at `e` is nearer than it, if any. */
  const nearerLine = (e: { clientX: number; clientY: number }) => {
    const pos = getInternalNode(id)?.internals.positionAbsolute;
    if (!pos) return { centre: null, line: null };
    const centre = { x: pos.x + J_HALF, y: pos.y + J_HALF };
    const at = screenToFlowPosition({ x: e.clientX, y: e.clientY }, { snapToGrid: false });
    const own = new Set(getEdges().filter(x => x.source === id || x.target === id).map(x => x.id));
    const line = lineSourceAt(at, getZoom(), lineId => own.has(lineId));
    const nearer = line && line.dist < Math.hypot(at.x - centre.x, at.y - centre.y) ? line.source : null;
    return { centre, line: nearer };
  };

  // The hover dot, as a line's band places it: named for the tee, so that
  // the tee leaving the page takes away a dot it put on a line.
  const by = `tee:${id}`;
  useEffect(() => () => forgetHover(by), [by]);
  /**
   * Over the halo or the ring, the dot goes where a press here would put a
   * tee: on the nearer line, or nowhere when the press is the tee's. Not
   * with a button held -- that is the tee being dragged, or a pull or a
   * port drag passing over it.
   */
  const onMouseMove = (e: React.MouseEvent) => {
    if (readOnly || e.buttons) return;
    const { clientX, clientY } = e;
    hoverAt(by, () => nearerLine({ clientX, clientY }).line, { getNodes, getEdges, drop });
  };
  /** A click, a double-click or a right-click nearer another line is that line's, as the press was. */
  const handOn = (e: React.MouseEvent) => {
    const { line } = nearerLine(e);
    if (line) handToLine(line.edgeId, e);
  };

  // Faces, not handles: they anchor the lines and take no pointer.
  const faceStyle = {
    width: 10, height: 10, background: 'transparent', border: 'none',
    pointerEvents: 'none' as const, boxShadow: 'none',
  };
  const ink = selected ? 'var(--color-text-primary)' : tint;
  const ring = 2 * outer + 2;

  return (
    <div
      title={open ? 'Open end — pull the ring to carry the line on' : 'Tee — drag to slide it along its run; pull the ring to branch'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); forgetHover(by); }}
      onMouseMove={onMouseMove}
      // The halo, the ring and the dot all bubble here. A click the tee
      // keeps goes on to React Flow, which picks the tee.
      onClick={handOn}
      onDoubleClick={handOn}
      onContextMenu={handOn}
      style={{
        width: 10, height: 10, borderRadius: '50%', position: 'relative',
        cursor: readOnly ? 'default' : 'grab',
        background: open ? 'var(--color-bg-primary)' : ink,
        border: `${BORDER}px solid ${open ? ink : 'var(--color-bg-secondary)'}`,
        boxShadow: open ? 'none' : `0 0 0 2px ${ink}`,
      }}
    >
      {/* Ten pixels is a hard thing to hit. This reaches a little past the
          dot without drawing anything, centred on it. A press on it that is
          nearer another line is that line's: pulled from there, and the
          press kept from React Flow, which would drag the tee. */}
      <div
        style={{ position: 'absolute', left: inset(2 * halo), top: inset(2 * halo), width: 2 * halo, height: 2 * halo, borderRadius: '50%' }}
        onPointerDown={e => {
          if (readOnly || e.button !== 0) return;
          const { line } = nearerLine(e);
          if (!line) return;
          e.stopPropagation();
          e.preventDefault();
          leaveHover();
          begin(line, e);
        }}
      />

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
          width={ring} height={ring} viewBox={`0 0 ${ring} ${ring}`}
          style={{ position: 'absolute', left: inset(ring), top: inset(ring), overflow: 'visible', pointerEvents: 'none' }}
        >
          <circle cx={ring / 2} cy={ring / 2} r={outer - 0.75} fill="none" stroke={ink} strokeWidth={1.5} strokeDasharray="3 2.5" />
          <circle
            className="nodrag"
            cx={ring / 2} cy={ring / 2} r={(RING_INNER + outer) / 2} fill="none" stroke="transparent" strokeWidth={outer - RING_INNER}
            style={{ pointerEvents: 'stroke', cursor: 'crosshair' }}
            onPointerDown={e => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.preventDefault();
              const { centre, line } = nearerLine(e);
              if (line) { leaveHover(); begin(line, e); }
              else if (centre) begin({ kind: 'node', nodeId: id, at: centre }, e);
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
