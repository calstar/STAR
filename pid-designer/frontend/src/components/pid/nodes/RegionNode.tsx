import { NodeResizer, type NodeProps } from '@xyflow/react';
import { useReadOnly } from '@stardesign-ui';
import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import type { PIDNodeData } from '../types';

/**
 * A labelled box drawn round a section of the drawing.
 *
 * Grouping by hand, for the things a solver has no opinion about: this panel,
 * that skid, everything inside the blast shelter. Purely for the reader, which
 * is why it holds no parameters and contributes nothing to the graph.
 *
 * Two details do the work:
 *
 * **The middle does not take clicks.** A region is large and sits over other
 * components, and a box that swallowed a click on the valve underneath it would
 * be unusable within a minute. Only the border and the title are interactive,
 * so the box can be moved and resized by its edge and is otherwise transparent
 * to everything inside it.
 *
 * **It sits behind.** Regions render under the components they enclose rather
 * than over them, so the drawing reads as components with a box around them
 * rather than a box with components on top.
 */
export function RegionNode({ id, data, selected }: NodeProps) {
  const { label, color } = data as unknown as PIDNodeData;
  const readOnly = useReadOnly();
  const { setNodes } = useReactFlow();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (!editing) setDraft(label ?? ''); }, [label, editing]);

  const stroke = color ?? '#64748b';

  const commit = () => {
    setNodes(nds => nds.map(n => (n.id === id ? { ...n, data: { ...n.data, label: draft } } : n)));
    setEditing(false);
  };

  return (
    <>
      <NodeResizer
        isVisible={!!selected && !readOnly}
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
          borderRadius: 8,
          background: `${stroke}0f`,
          // The fill is inert; the border is not. See the note above.
          pointerEvents: 'none',
          boxSizing: 'border-box',
        }}
      >
        <div
          className="nodrag"
          style={{
            position: 'absolute',
            top: -9,
            left: 10,
            pointerEvents: 'all',
            background: 'var(--color-bg-primary)',
            padding: '0 6px',
            fontSize: 11,
            lineHeight: '18px',
            color: stroke,
            fontFamily: 'monospace',
            letterSpacing: '0.04em',
            cursor: readOnly ? 'default' : 'text',
            userSelect: 'none',
          }}
          onDoubleClick={e => { if (readOnly) return; e.stopPropagation(); setEditing(true); setTimeout(() => inputRef.current?.select(), 0); }}
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
              style={{
                background: 'transparent', border: 'none', outline: 'none',
                color: stroke, font: 'inherit', width: `${Math.max(8, draft.length + 1)}ch`,
              }}
            />
          ) : (label || 'Section')}
        </div>

        {/* A grab strip along the top edge, so the box can be moved without
            having to find its 1.5 px border. */}
        <div
          style={{
            position: 'absolute', left: 0, right: 0, top: -4, height: 10,
            pointerEvents: 'all', cursor: readOnly ? 'default' : 'grab',
          }}
        />
      </div>
    </>
  );
}
