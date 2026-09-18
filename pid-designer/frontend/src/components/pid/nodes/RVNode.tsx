import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Frame } from './Frame';
import { turn } from '../route';
import { fmtParam } from '../fmt';

const W = 60, H = 60;

/**
 * A relief valve, with its set pressure on the face of it.
 *
 * A relief is the one component whose *number* is what a reader is checking:
 * whether the thing protecting a vessel lifts below what the vessel is rated
 * to. Two clicks away in a dialog is two clicks nobody takes while scanning a
 * sheet, so it is drawn.
 */
export function RVNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, params } = data as unknown as PIDNodeData;
  const stroke = selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)';
  const set = params?.set_pressure;
  const reseat = params?.reseat_pressure;
  const spin = ((((rotation ?? 0) % 360) + 360) % 360);

  // The box once turned, so the tag sits under what is drawn.
  const boxH = (rotation ?? 0) % 180 === 90 ? W : H;
  return (
    <Frame nodeId={id} w={W} h={H} rotation={rotation} extra={<>
        <Port position={turn(Position.Left, rotation)}  id="l" style={{ top: '50%' }} />
        <Port position={turn(Position.Right, rotation)} id="r" style={{ top: '50%' }} />
        {(set || reseat) && (
        <span
          style={{
            position: 'absolute', left: '50%', top: H - 8,
            transform: `translateX(-50%) rotate(${-spin}deg)`,
            fontSize: 9, lineHeight: 1.15, fontFamily: 'monospace',
            color: 'var(--color-text-primary)', whiteSpace: 'nowrap', textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          {set && <>{fmtParam(set)}</>}
          {reseat && (
            <>
              <br />
              <span style={{ color: 'var(--color-text-muted)' }}>↺ {fmtParam(reseat)}</span>
            </>
          )}
        </span>
      )}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: boxH + 2 }} />
      </>}
    >

      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <polygon points="6,18 54,42 54,18 6,42"
          fill="var(--color-bg-tertiary)" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <polyline points="20,18 24,10 28,18 32,10 36,18 40,10"
          fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
        <line x1="30" y1="10" x2="30" y2="18" stroke={stroke} strokeWidth={1.5} />
      </svg>

      

    </Frame>
  );
}
