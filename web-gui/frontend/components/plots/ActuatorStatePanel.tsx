'use client'

import { useSensorValue, useActuatorCommandedState } from '@/lib/store';
import { ActuatorState } from '@/lib/types';

interface ActuatorRowProps {
  label: string;
  entity: string;
  color: string;
  channel?: number;
}

/** Display follows state machine (expected for current state); ADC shown as readout only. */
function ActuatorRow({ label, entity, color, channel }: ActuatorRowProps) {
  const commanded = useActuatorCommandedState(entity);
  const adcNamed = useSensorValue(entity, 'raw_adc_counts');
  const channelEntity = channel != null ? `ACT.ACT_CH${channel}` : '';
  const adcChannel = useSensorValue(channelEntity, 'raw_adc_counts');
  const adc = adcNamed ?? (channelEntity ? adcChannel : null);
  const isOpen = commanded === ActuatorState.OPEN;
  const hasState = commanded === ActuatorState.OPEN || commanded === ActuatorState.CLOSED;

  return (
    <div className="flex items-center justify-between rounded-lg px-5 py-4 bg-gray-900/50">
      <div className="flex items-center gap-3">
        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-base font-bold text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-base font-mono text-gray-400">
          {adc != null ? adc.toLocaleString() : '---'}
        </span>
        <span
          className={`text-base font-black font-mono px-4 py-2 rounded-lg ${
            !hasState ? 'bg-gray-800 text-gray-600' :
            isOpen   ? 'bg-green-900/60 text-green-400 border border-green-800' :
                       'bg-red-900/60 text-red-400 border border-red-800'
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
    <div className="bg-card rounded-lg p-4 flex flex-col gap-3">
      <h3 className="text-base font-bold text-text-muted uppercase tracking-widest mb-1">{title}</h3>
      {actuators.map((a) => (
        <ActuatorRow
          key={a.entity}
          label={a.label}
          entity={a.entity}
          color={a.color}
          channel={'channel' in a ? a.channel : undefined}
        />
      ))}
    </div>
  );
}
