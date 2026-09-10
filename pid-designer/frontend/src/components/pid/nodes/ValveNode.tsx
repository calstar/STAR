import { Position, type NodeProps } from '@xyflow/react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Frame } from './Frame';
import { turn } from '../route';
import { Upright } from './Upright';

const W = 60, H = 60;

/**
 * The valve body.
 *
 * A normally-open valve is drawn hollow, the way an open bore is drawn on a
 * P&ID; normally closed stays filled. That is the state a procedure review
 * looks for first, and a two-letter tag in the corner was not enough to see it
 * across a sheet.
 */
function BowtieWithActuator({ selected, actuatorLabel, failOpen, rotation }: {
  selected: boolean; actuatorLabel: string; failOpen: boolean; rotation?: number;
}) {
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <polygon points="8,10 52,46 52,10 8,46"
        fill={failOpen ? 'none' : '#1e293b'} stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
      <rect x="22" y="2" width="16" height="10" rx="2" fill="#1e293b" stroke={stroke} strokeWidth={1.2} />
      <Upright rotation={rotation} cx={W / 2} cy={H / 2}>
        <text x="30" y="11" textAnchor="middle" fontSize="7" fill="#cbd5e1" fontFamily="monospace">{actuatorLabel}</text>
      </Upright>
      <line x1="30" y1="12" x2="30" y2="20" stroke={stroke} strokeWidth={1.5} />
    </svg>
  );
}

function ManualValve({ selected }: { selected: boolean }) {
  const stroke = selected ? '#3b82f6' : '#94a3b8';
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <polygon points="8,10 52,46 52,10 8,46" fill="#1e293b" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
      <rect x="24" y="2" width="12" height="12" rx="2" transform="rotate(45 30 8)"
        fill="#1e293b" stroke={stroke} strokeWidth={1.2} />
    </svg>
  );
}

export function ValveNode({ id, data, selected }: NodeProps) {
  const { componentType, label, labelOffset, rotation, options } = data as unknown as PIDNodeData;
  const actuator = componentType === 'SOL' ? 'S' : 'P';
  // Drawn, not just stored. Which way a valve fails is the difference between
  // a safe abort and a spill, and it is the first thing anyone reading the
  // drawing during a procedure review looks for -- so it belongs on the
  // symbol, not two clicks away inside a dialog.
  const failOpen = options?.failState === 'open';
  // The box the symbol occupies once turned, so the tag sits under what the
  // reader actually sees rather than under where it would have been unturned.
  const boxH = (rotation ?? 0) % 180 === 90 ? W : H;
  return (
    <Frame
      w={W} h={H} rotation={rotation}
      extra={<>
        <Port position={turn(Position.Left, rotation)}  id="l" />
        <Port position={turn(Position.Right, rotation)} id="r" />
        {componentType !== 'MAN' && (
          <span
            title={failOpen ? 'Normally open — passes with no command applied' : 'Normally closed — shuts with no command applied'}
            style={{
              position: 'absolute', right: 2, bottom: 6, fontSize: 8, lineHeight: 1,
              fontFamily: 'monospace', letterSpacing: '0.02em',
              color: failOpen ? '#f59e0b' : '#64748b',
            }}
          >
            {failOpen ? 'NO' : 'NC'}
          </span>
        )}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={{ x: -4, y: boxH + 2 }} />
      </>}
    >
      {componentType === 'MAN'
        ? <ManualValve selected={!!selected} />
        : <BowtieWithActuator selected={!!selected} actuatorLabel={actuator} failOpen={failOpen} rotation={rotation} />}
    </Frame>
  );
}

