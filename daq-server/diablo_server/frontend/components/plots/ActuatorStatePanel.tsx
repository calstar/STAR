'use client'

import { useActuatorCommandedState } from '@/lib/store';
import { ActuatorState } from '@/lib/types';

interface ActuatorRowProps {
  label: string;
  entity: string;
  color: string;
  channel?: number;
}

/** Display follows commanded state only (state machine / user command); no ADC. */
function ActuatorRow({ label, entity, color }: ActuatorRowProps) {
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
  actuators: { label: string; entity: string; color: string; channel?: number }[];
}

export default function ActuatorStatePanel({ title, actuators }: ActuatorStatePanelProps) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="caps mb-1">{title}</h3>
      {actuators.map((a) => (
        <ActuatorRow key={a.entity} label={a.label} entity={a.entity} color={a.color} />
      ))}
    </div>
  );
}
