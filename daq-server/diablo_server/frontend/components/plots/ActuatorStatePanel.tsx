'use client'

import { useActuatorCommandedState, useSensorValue } from '@/lib/store';
import { ActuatorState } from '@/lib/types';
import { formatBallValvePosition } from '@/lib/ball-valve';

interface ActuatorRowProps {
  label: string;
  entity: string;
  color: string;
  channel?: number;
  /** A ball valve also shows where it is: % open / % closed. */
  ballValve?: boolean;
}

/** Ball valve position beside its commanded state (ACT_Cal.{Role} aliases to BV<n>_Cal.CH<m>). */
export function BallValvePositionText({ entity, commanded, className }: {
  entity: string; commanded: ActuatorState | null; className?: string;
}) {
  const calEntity = entity.replace('ACT.', 'ACT_Cal.');
  const pct = useSensorValue(calEntity, 'position_pct');
  const status = useSensorValue(calEntity, 'cal_status');
  return (
    <span data-testid={`ball-valve-position:${entity}`} className={className}>
      {formatBallValvePosition(pct, status, commanded)}
    </span>
  );
}

/** Display follows commanded state (state machine / user command); a ball valve adds its position. */
function ActuatorRow({ label, entity, color, ballValve }: ActuatorRowProps) {
  const commanded = useActuatorCommandedState(entity);
  const isOpen = commanded === ActuatorState.OPEN;
  const hasState = commanded === ActuatorState.OPEN || commanded === ActuatorState.CLOSED;

  return (
    <div className="flex items-center justify-between border border-line-strong bg-[#0b0b0b] px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="h-2 w-2 flex-shrink-0" style={{ backgroundColor: color }} />
        <span className="text-[14px] font-semibold text-ink">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        {ballValve && (
          <BallValvePositionText entity={entity} commanded={commanded}
            className="text-sm font-mono tabular-nums text-yellow-400" />
        )}
        <span
          className={`border px-3 py-1 font-mono text-[12px] font-semibold uppercase tracking-[0.16em] ${
            !hasState ? 'border-line text-ink-4' :
            isOpen   ? 'border-green-500 text-green-400' :
                       'border-line-strong text-ink-3'
          }`}
        >
          {!hasState ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
        </span>
      </div>
    </div>
  );
}

interface ActuatorStatePanelProps {
  title: string;
  actuators: { label: string; entity: string; color: string; channel?: number; ballValve?: boolean }[];
}

export default function ActuatorStatePanel({ title, actuators }: ActuatorStatePanelProps) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="caps mb-1">{title}</h3>
      {actuators.map((a) => (
        <ActuatorRow key={a.entity} label={a.label} entity={a.entity} color={a.color} ballValve={a.ballValve} />
      ))}
    </div>
  );
}
