'use client'

import { useSensorValue, useSensorStore } from '@/lib/store';
import { SystemState } from '@/lib/types';

// Expected position: 'open' | 'closed' | null. Source: backend CSV + config (NO/NC for Idle).
type ExpectedPosition = 'open' | 'closed' | null;

interface ActuatorRowProps {
  label: string;
  entity: string;
  color: string;
  expected: ExpectedPosition;
}

function ActuatorRow({ label, entity, color, expected }: ActuatorRowProps) {
  // Try both named entity and channel fallback
  const status = useSensorValue(entity, 'status');
  const adcNamed = useSensorValue(entity, 'raw_adc_counts');

  // Extract channel number if present (e.g., ACT.ACT_CH7 -> 7)
  const entityMatch = entity.match(/ACT_CH(\d+)/);
  const channelNum = entityMatch ? parseInt(entityMatch[1], 10) : null;

  // Try channel-based lookup if we found a channel number
  // Use a dummy entity that won't match anything if no channel
  const channelEntity = channelNum ? `ACT.ACT_CH${channelNum}` : 'ACT._DUMMY_NO_CH';
  const adcChannel = useSensorValue(channelEntity, 'raw_adc_counts');

  // Prefer named entity, fallback to channel-based (only if channelNum exists)
  const adc = adcNamed ?? (channelNum ? adcChannel : null);
  const hasData = status !== null || adc !== null;
  const isOpen = status === 1 || (adc !== null && adc > 1000);

  // Determine if actual state matches expected
  const mismatch = expected !== null && hasData && (
    (expected === 'open' && !isOpen) || (expected === 'closed' && isOpen)
  );
  return (
    <div className={`flex items-center justify-between rounded-lg px-5 py-4 ${
      mismatch ? 'bg-yellow-950/40 border border-yellow-600/50' : 'bg-gray-900/50'
    }`}>
      <div className="flex items-center gap-3">
        <div className="w-4 h-4 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-base font-bold text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        {/* Expected position indicator */}
        {expected && (
          <span className={`text-xs font-mono px-2 py-1 rounded ${
            expected === 'open' ? 'bg-green-900/30 text-green-600' : 'bg-red-900/30 text-red-600'
          }`}>
            EXP:{expected === 'open' ? 'O' : 'C'}
          </span>
        )}
        <span className="text-base font-mono text-gray-400">
          {hasData ? (adc?.toLocaleString() ?? '---') : '---'}
        </span>
        <span
          className={`text-base font-black font-mono px-4 py-2 rounded-lg ${
            !hasData ? 'bg-gray-800 text-gray-600' :
            isOpen   ? 'bg-green-900/60 text-green-400 border border-green-800' :
                       'bg-red-900/60 text-red-400 border border-red-800'
          }`}
        >
          {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
        </span>
        {mismatch && <span className="text-yellow-400 text-lg">⚠</span>}
      </div>
    </div>
  );
}

interface ActuatorStatePanelProps {
  title: string;
  actuators: { label: string; entity: string; color: string }[];
}

export default function ActuatorStatePanel({ title, actuators }: ActuatorStatePanelProps) {
  const currentState = useSensorStore((s) => s.currentState);
  const actuatorExpectedPositions = useSensorStore((s) => s.actuatorExpectedPositions);

  // Use backend/CSV expected positions (includes NO/NC for Idle). DEBUG has none.
  const stateExpected = currentState != null ? (actuatorExpectedPositions[currentState] ?? {}) : {};

  return (
    <div className="bg-card rounded-lg p-4 flex flex-col gap-3">
      <h3 className="text-base font-bold text-text-muted uppercase tracking-widest mb-1">{title}</h3>
      {actuators.map((a) => (
        <ActuatorRow
          key={a.entity}
          {...a}
          expected={stateExpected[a.entity] ?? null}
        />
      ))}
    </div>
  );
}
