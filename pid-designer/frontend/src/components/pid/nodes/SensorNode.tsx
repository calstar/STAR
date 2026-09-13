import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Frame } from './Frame';
import { turn } from '../route';
import { Upright } from './Upright';

/**
 * An instrument: a circle with its type in it.
 *
 * **No ports.** A probe clips to what it measures (see `attach.ts`) rather
 * than being wired into the flow path, so connection points were four handles
 * that existed only to be dragged from by mistake.
 *
 * **Two sizes.** A stand has a lot of these, often several within a few inches
 * of each other, and full-size circles turn that corner of the drawing into a
 * pile. Small is the same symbol at 60%.
 */
const SIZES = { small: 36, normal: 60 } as const;

export function SensorNode({ id, data, selected }: NodeProps) {
  const { componentType, label, labelOffset, rotation, options, color } = data as unknown as PIDNodeData;
  const S = SIZES[(options?.size as keyof typeof SIZES) ?? 'normal'] ?? SIZES.normal;
  // Gauges and transducers are plumbed; probes and load cells clip.
  const tapped = componentType === 'PT' || componentType === 'PG';
  const stroke = selected ? '#3b82f6' : (color ?? '#94a3b8');

  return (
    <Frame nodeId={id} w={S} h={S} rotation={rotation} extra={<>
        {tapped && <Port position={turn(Position.Bottom, rotation)} id="b" />}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: S + 2 }} />
      </>}
    >
      {/* One tapping, at the bottom. Rotate the symbol to point it elsewhere. */}

      <svg width={S} height={S} viewBox="0 0 60 60">
        <circle
          cx="30" cy="30" r="26"
          fill="#1e293b"
          stroke={stroke}
          strokeWidth={selected ? 2.5 : 1.5}
        />
        <Upright rotation={rotation} x={30} y={34}>
          <text x="30" y="34" textAnchor="middle" fontSize="14" fill="#e2e8f0"
            fontFamily="monospace" fontWeight="bold">
            {componentType}
          </text>
        </Upright>
      </svg>

    </Frame>
  );
}
