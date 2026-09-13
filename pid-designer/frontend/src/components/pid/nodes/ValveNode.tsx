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
      {/* Anchored on the box's true centre, and centred on it in both
          directions. It used to sit on a baseline at the box's bottom edge,
          which reads as low unturned and lands off the box entirely once the
          letter is spun about that anchor. */}
      <Upright rotation={rotation} x={30} y={7}>
        <text x="30" y="7" textAnchor="middle" dominantBaseline="central"
          fontSize="7" fill="#cbd5e1" fontFamily="monospace">{actuatorLabel}</text>
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
  // Where the writing goes, which is wherever the ports are not.
  //
  // A valve's ports are on its left and right, so unturned there is room
  // underneath. Turn it and they are top and bottom -- and underneath is now
  // where the outlet is, complete with the vent arrow if that side is open.
  // So a turned valve carries its marker and its tag off to the side instead.
  const quarter = (rotation ?? 0) % 180 === 90;
  const boxW = quarter ? H : W;
  const boxH = quarter ? W : H;
  const markStyle: React.CSSProperties = quarter
    ? { left: boxW + 4, top: 2 }
    : { left: 0, top: boxH + 2 };
  const tagOffset = quarter
    ? { x: boxW + 4, y: 14 }
    : { x: -4, y: boxH + (componentType === 'MAN' ? 2 : 13) };
  return (
    <Frame
      nodeId={id} w={W} h={H} rotation={rotation}
      extra={<>
        <Port position={turn(Position.Left, rotation)}  id="l" />
        <Port position={turn(Position.Right, rotation)} id="r" />
        {componentType !== 'MAN' && (
          <span
            title={failOpen ? 'Normally open — passes with no command applied' : 'Normally closed — shuts with no command applied'}
            style={{
              // Its own row, with the tag on the next one. Inside the box the
              // bowtie was drawn across it -- the hourglass reaches all four
              // corners -- and sharing the tag's row meant a tag of any length
              // covered it.
              position: 'absolute', ...markStyle, fontSize: 8, lineHeight: 1,
              fontFamily: 'monospace', letterSpacing: '0.02em',
              color: failOpen ? '#f59e0b' : '#64748b',
              whiteSpace: 'nowrap', pointerEvents: 'none',
            }}
          >
            {failOpen ? 'NO' : 'NC'}
          </span>
        )}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={tagOffset} />
      </>}
    >
      {componentType === 'MAN'
        ? <ManualValve selected={!!selected} />
        : <BowtieWithActuator selected={!!selected} actuatorLabel={actuator} failOpen={failOpen} rotation={rotation} />}
    </Frame>
  );
}

