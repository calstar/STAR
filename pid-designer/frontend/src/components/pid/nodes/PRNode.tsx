import { Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { useEffect } from 'react';
import { Port } from './Port';
import type { PIDNodeData } from '../types';
import { DraggableLabel } from './DraggableLabel';
import { Frame } from './Frame';
import { turn } from '../route';
import { fmtParam } from '../fmt';

const W = 60, H = 60;

/**
 * A pressure regulator.
 *
 * Every piece of lettering lives outside the rotation. It used to be three
 * things placed by three rules -- "PR" counter-rotated about its own anchor
 * inside the artwork, "DOME" likewise, the setpoint an HTML span under the
 * box -- and a quarter turn spread them across the symbol, the setpoint under
 * the port the line now left from. The artwork turns; the words are placed
 * afresh for each turn, in the corners the diagonal does not cross, and off
 * to the side whenever a port is underneath.
 */
export function PRNode({ id, data, selected }: NodeProps) {
  const { label, labelOffset, rotation, options, params } = data as unknown as PIDNodeData;
  const setpoint = params?.setpoint;
  const stroke = selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)';
  // A dome-loaded regulator has a third connection, and which one it is
  // matters: the dome sets the outlet, so a line run to it by mistake is a
  // regulator held at whatever that line happens to be. Marked on the symbol
  // rather than left to be inferred from which side a wire arrives on.
  const domeLoaded = options?.domeLoaded === 'yes';
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [id, domeLoaded, updateNodeInternals]);

  const spin = ((((rotation ?? 0) % 360) + 360) % 360);
  const quarter = spin % 180 === 90;
  // The diagonal runs lower-left to upper-right unturned (and at 180); a
  // quarter turn swings it to upper-left / lower-right. The free corners are
  // the other two.
  const corner = (which: 'a' | 'b'): React.CSSProperties =>
    quarter
      ? (which === 'a' ? { right: 11, top: 10 } : { left: 11, bottom: 10 })
      : (which === 'a' ? { left: 11, top: 10 } : { right: 11, bottom: 10 });
  const lettering: React.CSSProperties = {
    position: 'absolute', fontSize: 9, lineHeight: 1, fontFamily: 'monospace',
    pointerEvents: 'none', whiteSpace: 'nowrap',
  };
  // A quarter turn puts a port under the box, so the number and the tag go
  // off to the side instead -- the same rule ValveNode uses for NC.
  const numberStyle: React.CSSProperties = quarter
    ? { left: W + 4, top: 2 }
    : { left: '50%', top: H - 6, transform: 'translateX(-50%)' };
  const tagOffset = quarter
    ? { x: W + 4, y: setpoint ? 14 : 2 }
    : { x: -4, y: H + (setpoint ? 8 : 2) };

  return (
    <Frame nodeId={id} w={W} h={H} rotation={rotation} extra={<>
        <Port position={turn(Position.Left, rotation)}  id="l" />
        <Port position={turn(Position.Right, rotation)} id="r" />
        {/* The top is the dome when the regulator has one; otherwise it is a
            plain third port, as upstream drawings connect it. */}
        {domeLoaded
          ? <Port position={turn(Position.Top, rotation)} id="dome" />
          : <Port position={turn(Position.Top, rotation)} id="t" />}
        <span style={{ ...lettering, ...corner('a'), color: 'var(--color-text-primary)' }}>PR</span>
        {domeLoaded && (
          <span style={{ ...lettering, ...corner('b'), fontSize: 5.5, color: 'var(--color-text-primary)' }}>DOME</span>
        )}
        {/* The setpoint, on the face of it. A regulator's number is what a
            reviewer scans a sheet for, and two clicks into a dialog is two
            clicks nobody takes while scanning. */}
        {setpoint && (
          <span style={{ ...lettering, ...numberStyle, color: 'var(--color-text-primary)' }}>
            {fmtParam(setpoint)}
          </span>
        )}
        <DraggableLabel nodeId={id} label={label} offset={labelOffset} defaultOffset={tagOffset} />
      </>}
    >
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <rect x="8" y="8" width="44" height="44" rx="3"
          fill="var(--color-bg-tertiary)" stroke={stroke} strokeWidth={selected ? 2.5 : 1.5} />
        <line x1="16" y1="44" x2="44" y2="16" stroke={stroke} strokeWidth={1.5} />
        <polygon points="44,16 36,18 42,24" fill={stroke} />
        {!domeLoaded && <line x1="30" y1="0" x2="30" y2="8" stroke={stroke} strokeWidth={1.5} />}
        {domeLoaded && (
          <>
            {/* the dome, and the stem tying it to the seat */}
            <path d="M22,8 Q30,0 38,8 Z" fill="var(--color-bg-tertiary)" stroke={stroke} strokeWidth={1.2} />
            <line x1="30" y1="8" x2="30" y2="14" stroke={stroke} strokeWidth={1.2} />
          </>
        )}
      </svg>
    </Frame>
  );
}
