import { useState, useRef, useEffect, useCallback } from 'react';
import { useReadOnly } from '@stardesign-ui';
import { type NodeProps, useReactFlow } from '@xyflow/react';

interface TextNodeData {
  text: string;
  fontSize?: number;
  color?: string;
}

export function TextNode({ id, data, selected }: NodeProps) {
  const { setNodes } = useReactFlow();
  // Edits through useReactFlow rather than the canvas's handlers, so
  // ReactFlow's interaction props do not reach it -- it checks itself.
  const readOnly = useReadOnly();
  const nodeData = data as unknown as TextNodeData;

  const [editing, setEditing] = useState(false);
  const [text, setText]       = useState(nodeData.text ?? 'Text');
  const [hovered, setHovered] = useState(false);
  const taRef                 = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { if (!editing) setText(nodeData.text ?? 'Text'); }, [nodeData.text, editing]);

  const commit = useCallback((val: string) => {
    setNodes(nds => nds.map(n =>
      n.id === id ? { ...n, data: { ...n.data, text: val } } : n,
    ));
    setEditing(false);
  }, [id, setNodes]);

  const onDoubleClick = (e: React.MouseEvent) => {
    if (readOnly) return;
    e.stopPropagation();
    setEditing(true);
    setTimeout(() => taRef.current?.select(), 0);
  };

  const fontSize = nodeData.fontSize ?? 13;
  const color    = nodeData.color    ?? '#e2e8f0';

  return (
    <div
      style={{ minWidth: 80, minHeight: 24, display: 'flex', flexDirection: 'column' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        style={{
          height: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          opacity: hovered || selected ? 1 : 0,
          transition: 'opacity 0.15s',
          color: '#64748b',
          fontSize: 10,
          letterSpacing: 1,
          userSelect: 'none',
        }}
        title="Drag to move"
      >
        ⠿
      </div>

      <div className="nodrag" onDoubleClick={onDoubleClick} onClick={e => e.stopPropagation()}>
        {editing ? (
          <textarea
            ref={taRef}
            autoFocus
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={() => commit(text)}
            onKeyDown={e => {
              if (e.key === 'Escape') commit(text);
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(text); }
            }}
            onMouseDown={e => e.stopPropagation()}
            rows={Math.max(1, text.split('\n').length)}
            style={{
              fontSize,
              color,
              background: 'rgba(15,23,42,0.85)',
              border: '1px solid #3b82f6',
              borderRadius: 4,
              padding: '2px 6px',
              outline: 'none',
              resize: 'both',
              fontFamily: 'inherit',
              lineHeight: 1.4,
              minWidth: 80,
              display: 'block',
            }}
          />
        ) : (
          <div
            style={{
              fontSize,
              color,
              background: selected ? 'rgba(59,130,246,0.08)' : 'transparent',
              border: selected ? '1px dashed #3b82f6' : '1px dashed transparent',
              borderRadius: 4,
              padding: '2px 6px',
              cursor: 'default',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.4,
              minWidth: 80,
              minHeight: 24,
            }}
          >
            {nodeData.text || <span style={{ color: '#475569', fontStyle: 'italic' }}>double-click to edit</span>}
          </div>
        )}
      </div>
    </div>
  );
}
