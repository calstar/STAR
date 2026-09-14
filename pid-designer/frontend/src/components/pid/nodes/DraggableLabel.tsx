import { useState, useCallback, useEffect, useRef } from 'react';
import { useReadOnly } from '@stardesign-ui';
import { useReactFlow } from '@xyflow/react';

interface DraggableLabelProps {
  nodeId: string;
  label: string;
  offset?: { x: number; y: number };
  /** Where the tag sits when nobody has dragged it. Measured from the top-left
   *  of the symbol's box *as drawn*, so a caller that turns its artwork passes
   *  the turned box's height and the tag stays underneath it. */
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

  // Nothing here turns any more. A symbol's rotation is applied to its
  // artwork alone (see `Frame`), so the tag is drawn in the box's own frame:
  // upright by construction, and below the symbol as it actually appears
  // rather than below where it would have been unturned.
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
      const dx = (e.clientX - dragStart.current.mouseX) / zoom;
      const dy = (e.clientY - dragStart.current.mouseY) / zoom;

      setNodes(nds => nds.map(n =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, labelOffset: {
              x: dragStart.current!.ox + dx,
              y: dragStart.current!.oy + dy,
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
          readOnly={readOnly}
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
            // Opaque, not 80%. A tank's tag sits directly under its bottom
            // port, so the run leaving that port passes behind the text --
            // and at 80% it showed through the letters.
            background: dragging ? 'rgba(59,130,246,0.15)' : 'var(--color-bg-primary)',
            outline:    dragging ? '1px dashed #3b82f6' : 'none',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
