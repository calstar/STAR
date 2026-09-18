import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react';
import { useReadOnly } from '@stardesign-ui';
import { useEffect, useRef, useState } from 'react';
import type { PIDNodeData } from '../types';

/**
 * A labelled box drawn round part of the diagram.
 *
 * The middle takes no clicks -- a region is large and sits over other
 * components, and a box that swallowed a click on the valve underneath it
 * would be unusable. Only the title bar is interactive, and it is where the
 * box is dragged, renamed and right-clicked from.
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

  const stroke = color ?? 'var(--color-text-muted)';

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
          borderRadius: 6,
          background: `${stroke}0d`,
          pointerEvents: 'none',
          boxSizing: 'border-box',
        }}
      >
        <div
          className="nodrag"
          style={{
            position: 'absolute',
            top: -10,
            left: 8,
            pointerEvents: 'all',
            background: 'var(--color-bg-primary)',
            padding: '0 6px',
            fontSize: 11,
            lineHeight: '20px',
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
