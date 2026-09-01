import { useState, useCallback, useEffect, useRef } from 'react';
import { useReadOnly } from '@stardesign-ui';
import { useReactFlow } from '@xyflow/react';

interface DraggableLabelProps {
  nodeId: string;
  label: string;
  offset?: { x: number; y: number };
  defaultOffset: { x: number; y: number };
}

export function DraggableLabel({ nodeId, label, offset, defaultOffset }: DraggableLabelProps) {
  const { setNodes, getViewport } = useReactFlow();
  // This edits through useReactFlow rather than the canvas's own handlers,
  // so ReactFlow's interaction props do not reach it. It has to check the
  // checkout itself.
  const readOnly = useReadOnly();
  const [editing, setEditing]   = useState(false);
  const [editVal, setEditVal]   = useState(label);
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered]   = useState(false);
  const dragStart = useRef<{ mouseX: number; mouseY: number; ox: number; oy: number } | null>(null);

  useEffect(() => { if (!editing) setEditVal(label); }, [label, editing]);

  const currentOffset = offset ?? defaultOffset;

  const commitLabel = useCallback(() => {
    setNodes(nds => nds.map(n =>
      n.id === nodeId ? { ...n, data: { ...n.data, label: editVal } } : n,
    ));
    setEditing(false);
  }, [nodeId, editVal, setNodes]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setDragging(true);
    dragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      ox: currentOffset.x,
      oy: currentOffset.y,
    };
  }, [currentOffset]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e: MouseEvent) => {
      if (!dragStart.current) return;
      const { zoom } = getViewport();
      setNodes(nds => nds.map(n =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, labelOffset: {
              x: dragStart.current!.ox + (e.clientX - dragStart.current!.mouseX) / zoom,
              y: dragStart.current!.oy + (e.clientY - dragStart.current!.mouseY) / zoom,
            }}}
          : n,
      ));
    };

    const onUp = () => { setDragging(false); dragStart.current = null; };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup',   onUp,   true);
    return () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup',   onUp,   true);
    };
  }, [dragging, nodeId, setNodes, getViewport]);

  return (
    <div
      className="nodrag"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        transform: `translate(${currentOffset.x}px, ${currentOffset.y}px)`,
        userSelect: 'none',
        zIndex: 10,
        whiteSpace: 'nowrap',
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => !dragging && setHovered(false)}
      onClick={e => e.stopPropagation()}
    >
      <span
        onMouseDown={onHandleMouseDown}
        style={{
          cursor: dragging ? 'grabbing' : 'grab',
          opacity: hovered || dragging ? 1 : 0,
          transition: 'opacity 0.15s',
          fontSize: '10px',
          color: '#64748b',
          lineHeight: 1,
          padding: '0 2px',
        }}
        title="Drag to reposition label"
      >
        ⠿
      </span>

      {editing ? (
        <input
          autoFocus
          value={editVal}
          onChange={e => setEditVal(e.target.value)}
          onBlur={commitLabel}
          onKeyDown={e => {
            if (e.key === 'Enter')  commitLabel();
            if (e.key === 'Escape') setEditing(false);
          }}
          onMouseDown={e => e.stopPropagation()}
          className="text-xs text-center bg-[#1e293b] border border-blue-500 text-white rounded px-1 w-24 outline-none"
          style={{ cursor: 'text' }}
        />
      ) : (
        <span
          onDoubleClick={e => { if (readOnly) return; e.stopPropagation(); setEditing(true); }}
          className="text-xs px-1 rounded leading-tight"
          style={{
            cursor: 'default',
            color:      dragging ? '#3b82f6' : '#cbd5e1',
            background: dragging ? 'rgba(59,130,246,0.15)' : 'rgba(10,15,26,0.8)',
            outline:    dragging ? '1px dashed #3b82f6' : 'none',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
