import { NodeResizer, useReactFlow, useStore, useStoreApi, type NodeProps, type ReactFlowState } from '@xyflow/react';
import { useReadOnly } from '@stardesign-ui';
import { useEffect, useRef, useState } from 'react';
import type { PIDNodeData } from '../types';

/** The title bar's height. */
const TITLE_H = 20;

interface Box { x: number; y: number; width: number; height: number }

/**
 * The rubber band in flow coordinates. React Flow keeps it in screen px
 * measured from the pane's corner, which is what it hands its own hit test.
 */
function bandInFlow(rect: Box, [tx, ty, zoom]: readonly [number, number, number]): Box {
  return { x: (rect.x - tx) / zoom, y: (rect.y - ty) / zoom, width: rect.width / zoom, height: rect.height / zoom };
}

/** How much of `box` the band covers: none of it, some of it, or all of it. */
function bandCovers(band: Box, box: Box): 'none' | 'part' | 'whole' {
  const w = Math.min(band.x + band.width, box.x + box.width) - Math.max(band.x, box.x);
  const h = Math.min(band.y + band.height, box.y + box.height) - Math.max(band.y, box.y);
  if (w <= 0 || h <= 0) return 'none';
  const whole = band.x <= box.x && band.y <= box.y
    && band.x + band.width >= box.x + box.width && band.y + band.height >= box.y + box.height;
  return whole ? 'whole' : 'part';
}

type BandState = Pick<ReactFlowState, 'userSelectionRect' | 'userSelectionActive' | 'transform' | 'nodeLookup' | 'triggerNodeChanges'>;

/** Where section `id` is on the canvas, as React Flow's own hit test measures it. */
function boxOf(s: BandState, id: string): Box | null {
  const n = s.nodeLookup.get(id);
  if (!n) return null;
  return {
    ...n.internals.positionAbsolute,
    width: n.measured.width ?? n.width ?? n.initialWidth ?? 0,
    height: n.measured.height ?? n.height ?? n.initialHeight ?? 0,
  };
}

/** Whether a band being drawn now covers only part of section `id`. */
export function bandOnPartOf(s: BandState, id: string): boolean {
  if (!s.userSelectionActive || !s.userSelectionRect) return false;
  const box = boxOf(s, id);
  return !!box && bandCovers(bandInFlow(s.userSelectionRect, s.transform), box) === 'part';
}

/**
 * Let go of section `id` when a rubber band that only partly covered it ends.
 *
 * The canvas box-selects in React Flow's Partial mode, which takes anything
 * the band touches, and that is right for a valve: a band dragged across
 * half of one means it. It is wrong for a section. A section is drawn round
 * the parts it labels, so any band drawn among those parts touches it -- and
 * now that a press inside a section starts a band rather than a drag of the
 * box, that is the ordinary way to select them. Taking the section as well
 * meant that dragging the selection moved the box out from under the parts
 * that were left, and Delete deleted it with them: empty canvas inside a
 * section still did not behave like empty canvas outside it. So a band takes
 * a section only when it encloses the whole box, as a band in Full mode
 * would; the title bar still selects it with a click.
 *
 * Done when the band is let go, from the band's last rectangle, because
 * React Flow re-selects only when the set it has worked out changes, so
 * dropping its selection of the section part-way through would not stay
 * dropped. The internal node is let go of as well as the one handed to the
 * app, as React Flow's own `unselectNodesAndEdges` does, so that the box
 * round the selection -- which is dragged from the internal nodes -- does not
 * carry the section before the app's copy has rendered.
 *
 * Takes the store rather than calling hooks so the whole gesture can be run
 * against React Flow's own hit test without a DOM.
 */
export function releaseFromBand(
  store: { subscribe(listener: (s: BandState, prev: BandState) => void): () => void },
  id: string,
): () => void {
  return store.subscribe((s, prev) => {
    // React Flow clears the rectangle on pointer-up; `userSelectionActive`
    // says the pointer moved far enough to be a band rather than a click.
    if (s.userSelectionRect || !prev.userSelectionRect || !prev.userSelectionActive) return;
    const node = s.nodeLookup.get(id);
    if (!node?.selected || !bandOnPartOf(prev, id)) return;
    node.selected = false;
    s.triggerNodeChanges([{ id, type: 'select', selected: false }]);
  });
}

/**
 * A labelled box drawn round part of the diagram.
 *
 * The middle takes no clicks -- a region is large and sits over other
 * components, and a box that swallowed a click on the valve underneath it
 * would be unusable. Only the title bar is interactive, and it is where the
 * box is dragged, renamed and right-clicked from.
 *
 * "The middle takes no clicks" has to hold for React Flow's own wrapper round
 * this component too, not just for the box drawn inside it. The wrapper is
 * the size of the section and writes `pointer-events: all` on itself inline
 * whenever a node can be selected or dragged, so a press on empty canvas
 * inside a section dragged the section off the components it was drawn round
 * instead of starting a box-select or a pan. The stylesheet overrides that
 * for sections (`.react-flow__node-REGION` in index.css), which covers every
 * section, including those in drawings saved before this, without a
 * migration.
 *
 * The title bar is the one place a press lands. It used to be marked
 * `nodrag`, which, once the body was the only other target, left a section
 * nothing could move; so it is the drag handle now, and only the rename box
 * inside it refuses a drag, so that text in it can be selected.
 *
 * The title used to sit under a separate invisible grab strip, which is why
 * double-clicking it to rename did nothing: the strip was drawn after the
 * title and took the event. There is one interactive element now, so there is
 * nothing to be shadowed by.
 */
export function RegionNode({ id, data, selected }: NodeProps) {
  const { label, color } = data as unknown as PIDNodeData;
  const readOnly = useReadOnly();
  const { setNodes } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(label ?? ''); }, [label, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  // See `releaseFromBand`. While the band is still being drawn React Flow has
  // the section selected, so its resize handles are kept hidden until the
  // band either encloses it or is let go.
  const store = useStoreApi();
  useEffect(() => releaseFromBand(store, id), [store, id]);
  const heldBack = useStore(s => bandOnPartOf(s, id));

  const stroke = color ?? 'var(--color-text-muted)';

  const commit = () => {
    setNodes(nds => nds.map(n => (n.id === id ? { ...n, data: { ...n.data, label: draft } } : n)));
    setEditing(false);
  };

  return (
    <>
      <NodeResizer
        isVisible={!!selected && !readOnly && !heldBack}
        minWidth={120}
        minHeight={90}
        color={stroke}
        lineStyle={{ borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <div
        style={{
          width: '100%',
          height: '100%',
          border: `1.5px dashed ${stroke}`,
          borderRadius: 6,
          background: `${stroke}0d`,
          pointerEvents: 'none',
          boxSizing: 'border-box',
        }}
      >
        {/* A tab on top of the box rather than a legend across its edge.
            Straddling the border, the title's lower half lay inside the
            section, where a press meant for the canvas started a drag of
            the box; above it, the inside of the box is all canvas. */}
        <div
          style={{
            position: 'absolute',
            top: -TITLE_H,
            left: 8,
            pointerEvents: 'all',
            background: 'var(--color-bg-primary)',
            padding: '0 6px',
            fontSize: 11,
            lineHeight: `${TITLE_H}px`,
            color: stroke,
            fontFamily: 'monospace',
            letterSpacing: '0.04em',
            cursor: readOnly ? 'default' : editing ? 'text' : 'grab',
            userSelect: 'none',
            whiteSpace: 'nowrap',
          }}
          title={readOnly ? undefined : 'Double-click to rename · right-click to colour'}
          onDoubleClick={e => {
            if (readOnly) return;
            e.stopPropagation();
            setEditing(true);
          }}
        >
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              readOnly={readOnly}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(false);
              }}
              onMouseDown={e => e.stopPropagation()}
              className="nodrag"
              style={{
                background: 'transparent', border: 'none', outline: 'none',
                color: stroke, font: 'inherit', width: `${Math.max(8, draft.length + 1)}ch`,
              }}
            />
          ) : (label || 'Section')}
        </div>
      </div>
    </>
  );
}
