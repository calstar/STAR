import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { useEffect } from 'react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Upright } from './Upright';

const W = 60, H = 60;

export function PRNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, options } = data as unknown as PIDNodeData;
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  // A dome-loaded regulator has a third connection, and which one it is
  // matters: the dome sets the outlet, so a line run to it by mistake is a
  // regulator held at whatever that line happens to be. Marked on the symbol
  // rather than left to be inferred from which side a wire arrives on.
  const domeLoaded = options?.domeLoaded === 'yes';
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, domeLoaded, updateNodeInternals]);

  return (
    <div style={{ position: 'relative', width: W, height: H, transform: `rotate(${rotation ?? 0}deg)`, transformOrigin: 'center' }}>
      <Port position={Position.Left}  id="l" />
      <Port position={Position.Right} id="r" />
      {domeLoaded && <Port position={Position.Top} id="dome" />}

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <rect x="8" y="8" width="44" height="44" rx="3"
          fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <line x1="16" y1="44" x2="44" y2="16" stroke={stroke} strokeWidth={1.5} />
        <polygon points="44,16 36,18 42,24" fill={stroke} />
        <Upright rotation={rotation} cx={W / 2} cy={H / 2}>
          <text x="16" y="28" fontSize="9" fill="#e2e8f0" fontFamily="monospace">PR</text>
        </Upright>
        {domeLoaded && (
          <>
            {/* the dome, and the stem tying it to the seat */}
            <path d="M22,8 Q30,0 38,8 Z" fill="#1e293b" stroke={stroke} strokeWidth={1.2} />
            <line x1="30" y1="8" x2="30" y2="14" stroke={stroke} strokeWidth={1.2} />
            {/* Beside the dome, not under it. Centred at x=30 it sat on the
                stem and directly under the dome port, so the line feeding the
                dome ran straight through the word. */}
            <Upright rotation={rotation} cx={W / 2} cy={H / 2}>
              <text x="46" y="7" textAnchor="middle" fontSize="5.5" fill="#f59e0b" fontFamily="monospace">DOME</text>
            </Upright>
          </>
        )}
      </svg>

      <DraggableLabel nodeId={id} label={label} offset={labelOffset} rotation={rotation} defaultOffset={{ x: -4, y: H + 2 }} />
    </div>
  );
}
