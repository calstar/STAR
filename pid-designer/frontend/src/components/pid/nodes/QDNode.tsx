import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Frame } from './Frame';
import { turn } from '../route';
import { Upright } from './Upright';

const W = 60, H = 60;

/**
 * A quick disconnect: fluid, or hydraulic.
 *
 * The two are functionally the same and are told apart on sight -- a hydraulic
 * body is dashed -- so nobody traces an actuation line looking for propellant.
 * Which half mates with which is named in the config rather than drawn, because
 * it is a relationship between two symbols and not a property of either.
 */
export function QDNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, options } = data as unknown as PIDNodeData;
  const stroke = selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)';
  const hydraulic = options?.service === 'hydraulic';

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
        <circle
          cx="30" cy="30" r="25"
          fill="var(--color-bg-tertiary)"
          stroke={stroke}
          strokeWidth={selected ? 2.5 : 1.5}
          // A hydraulic disconnect reads as dashed, so the two are separable in
          // a monochrome print as well as on screen.
          strokeDasharray={hydraulic ? '5 3' : undefined}
        />
        <line x1="14" y1="14" x2="46" y2="46" stroke={stroke} strokeWidth={2} />
        <line x1="46" y1="14" x2="14" y2="46" stroke={stroke} strokeWidth={2} />
        {hydraulic && (
          <Upright rotation={rotation} x={30} y={52}>
            <text x="30" y="52" textAnchor="middle" fontSize="7" fill="var(--color-text-secondary)" fontFamily="monospace">HYD</text>
          </Upright>
        )}
      </svg>

    </Frame>
  );
}
