'use client'

import { useSensorValue, useSensorStore } from '@/lib/store';
import { SystemState } from '@/lib/types';

// Expected actuator positions per system state: 'open' | 'closed' | null (don't care)
// Updated from new CSV: "Avionics Board Status - State Machine Actuators.csv"
type ExpectedPosition = 'open' | 'closed' | null;

const EXPECTED_POSITIONS: Record<number, Record<string, ExpectedPosition>> = {
  [SystemState.DEBUG]: {}, // DEBUG mode - no expected positions, manual control
  [SystemState.IDLE]: {
    'ACT.LOX_Main': 'open', 'ACT.Fuel_Main': 'open', 'ACT.LOX_Vent': 'open',
    'ACT.Fuel_Vent': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Press': 'open',
    'ACT.GN2_Vent': 'open',
  },
  [SystemState.ARMED]: {
    'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed',
    'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed',
    'ACT.GN2_Vent': 'closed',
  },
  [SystemState.FUEL_FILL]: {
    'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GN2_Vent': 'open',
    'ACT.Fuel_Press': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed',
  },
  [SystemState.OX_FILL]: {
    'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GN2_Vent': 'open',
    'ACT.Fuel_Press': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed',
  },
  [SystemState.GN2_LOW_PRESS]: {
    'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Press': 'closed',
    'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.FUEL_PRESS]: {
    'ACT.Fuel_Press': 'open', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed',
    'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.FUEL_VENT]: {
    'ACT.Fuel_Vent': 'open', 'ACT.Fuel_Press': 'closed', 'ACT.LOX_Vent': 'closed',
    'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.OX_PRESS]: {
    'ACT.LOX_Press': 'open', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed',
    'ACT.Fuel_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.OX_VENT]: {
    'ACT.LOX_Vent': 'open', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Press': 'closed',
    'ACT.Fuel_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.GN2_HIGH_PRESS]: {
    'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Press': 'closed',
    'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.GN2_VENT]: {
    'ACT.GN2_Vent': 'open', 'ACT.Fuel_Press': 'open', 'ACT.Fuel_Vent': 'closed',
    'ACT.LOX_Vent': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed',
  },
  [SystemState.CALIBRATE]: {
    'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Press': 'closed',
    'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.READY]: {
    'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Press': 'closed',
    'ACT.LOX_Press': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.FIRE]: {
    'ACT.Fuel_Main': 'open', 'ACT.Fuel_Press': 'open', 'ACT.LOX_Main': 'open', 'ACT.LOX_Press': 'open',
    'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.GN2_Vent': 'closed',
  },
  [SystemState.VENT]: {
    'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GN2_Vent': 'open',
    'ACT.Fuel_Press': 'open', 'ACT.LOX_Press': 'open',
    'ACT.Fuel_Main': 'closed', 'ACT.LOX_Main': 'closed',
  },
  [SystemState.ABORT]: {
    'ACT.Fuel_Vent': 'open', 'ACT.LOX_Vent': 'open', 'ACT.GN2_Vent': 'open',
    'ACT.Fuel_Press': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Main': 'open',
    'ACT.LOX_Main': 'closed',
  },
};

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

  // Get expected positions for current state
  const stateExpected = currentState != null ? (EXPECTED_POSITIONS[currentState] ?? {}) : {};

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
