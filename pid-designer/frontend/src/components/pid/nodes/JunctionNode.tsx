import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';

export function JunctionNode(_props: NodeProps) {
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
        background: '#94a3b8',
        border: '2px solid #0f172a',
        boxShadow: '0 0 0 2px #475569',
        position: 'relative',
      }}
      className="nodrag"
    >
      <Port position={Position.Top}   id="t" style={handleStyle} />
      <Port position={Position.Left}  id="l" style={handleStyle} />
      <Port position={Position.Bottom} id="b" style={handleStyle} />
      <Port position={Position.Right}  id="r" style={handleStyle} />
    </div>
  );
}
