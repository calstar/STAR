import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Frame } from './Frame';
import { turn } from '../route';

const W = 60, H = 60;

/**
 * A check valve, and which way it lets flow go.
 *
 * Drawn with an arrow, because the direction is the whole component. The old
 * artwork was a ball against a seat with no arrow, and the two readings of
 * it were about equally common -- so a valve drawn backwards looked exactly
 * like one drawn right. Flow is from `l` to `r`, as `ports.CV_INLET` says,
 * and the checks panel reads the same constant to say when the drawing has
 * one facing the wrong way.
 */
export function CheckValveNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation } = data as unknown as PIDNodeData;
  const stroke = selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)';
  // The box once turned, so the tag sits under what is drawn.
  const boxH = (rotation ?? 0) % 180 === 90 ? W : H;
  return (
    <Frame nodeId={id} w={W} h={H} rotation={rotation} extra={<>
        <Port position={turn(Position.Left, rotation)}  id="l" />
        <Port position={turn(Position.Right, rotation)} id="r" />
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: boxH + 2 }} />
      </>}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* seat, and the ball resting against it */}
        <line x1="34" y1="14" x2="34" y2="46" stroke={stroke} strokeWidth={2} />
        <circle cx="25" cy="30" r="8" fill="var(--color-bg-tertiary)" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        {/* the run through the body */}
        <line x1="4" y1="30" x2="17" y2="30" stroke={stroke} strokeWidth={1.5} />
        <line x1="34" y1="30" x2="46" y2="30" stroke={stroke} strokeWidth={1.5} />
        {/* the arrow: the only reading there is */}
        <polygon points="46,25 56,30 46,35" fill={stroke} />
      </svg>
    </Frame>
  );
}
