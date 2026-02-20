'use client'

import { useSensorValue, useSensorStore } from '@/lib/store';
import { SystemState } from '@/lib/types';

// Expected actuator positions per system state: 'open' | 'closed' | null (don't care)
type ExpectedPosition = 'open' | 'closed' | null;

const EXPECTED_POSITIONS: Record<number, Record<string, ExpectedPosition>> = {
  [SystemState.IDLE]:    { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed', 'ACT.GSE_Low_Vent': 'closed' },
  [SystemState.ARMED]:   { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed', 'ACT.GSE_Low_Vent': 'closed' },
  [SystemState.FUEL_FILL]:     { 'ACT.Fuel_Main': 'open', 'ACT.LOX_Main': 'closed' },
  [SystemState.OX_FILL]:       { 'ACT.LOX_Main': 'open', 'ACT.Fuel_Main': 'closed' },
  [SystemState.GN2_LOW_PRESS]: { 'ACT.Fuel_Press': 'open', 'ACT.LOX_Press': 'open', 'ACT.Fuel_Vent': 'closed', 'ACT.LOX_Vent': 'closed' },
  [SystemState.GN2_VENT]:      { 'ACT.GSE_Low_Vent': 'open', 'ACT.Fuel_Press': 'closed', 'ACT.LOX_Press': 'closed' },
  [SystemState.FUEL_PRESS]:    { 'ACT.Fuel_Press': 'open', 'ACT.Fuel_Vent': 'closed' },
  [SystemState.FUEL_VENT]:     { 'ACT.Fuel_Vent': 'open', 'ACT.Fuel_Press': 'closed' },
  [SystemState.OX_PRESS]:      { 'ACT.LOX_Press': 'open', 'ACT.LOX_Vent': 'closed' },
  [SystemState.OX_VENT]:       { 'ACT.LOX_Vent': 'open', 'ACT.LOX_Press': 'closed' },
  [SystemState.READY]:   { 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed' },
  [SystemState.FIRE]:    { 'ACT.LOX_Main': 'open', 'ACT.Fuel_Main': 'open', 'ACT.LOX_Vent': 'closed', 'ACT.Fuel_Vent': 'closed' },
  [SystemState.VENT]:    { 'ACT.LOX_Vent': 'open', 'ACT.Fuel_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed' },
  [SystemState.ABORT]:   { 'ACT.LOX_Vent': 'open', 'ACT.Fuel_Vent': 'open', 'ACT.GSE_Low_Vent': 'open', 'ACT.LOX_Main': 'closed', 'ACT.Fuel_Main': 'closed', 'ACT.LOX_Press': 'closed', 'ACT.Fuel_Press': 'closed' },
};

interface ActuatorRowProps {
  label: string;
  entity: string;
  color: string;
  expected: ExpectedPosition;
}

function ActuatorRow({ label, entity, color, expected }: ActuatorRowProps) {
  const adc = useSensorValue(entity, 'raw_adc_counts');
  const hasData = adc !== null;
  const isOpen = hasData && adc > 1000;

  // Determine if actual state matches expected
  const mismatch = expected !== null && hasData && (
    (expected === 'open' && !isOpen) || (expected === 'closed' && isOpen)
  );

  return (
    <div className={`flex items-center justify-between rounded px-3 py-2 ${
      mismatch ? 'bg-yellow-950/40 border border-yellow-600/50' : 'bg-gray-900/50'
    }`}>
      <div className="flex items-center gap-2">
        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-sm font-bold text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className="flex items-center gap-2">
        {/* Expected position indicator */}
        {expected && (
          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
            expected === 'open' ? 'bg-green-900/30 text-green-600' : 'bg-red-900/30 text-red-600'
          }`}>
            EXP:{expected === 'open' ? 'O' : 'C'}
          </span>
        )}
        <span className="text-xs font-mono text-gray-400">
          {hasData ? adc.toLocaleString() : '---'}
        </span>
        <span
          className={`text-xs font-bold font-mono px-2.5 py-1 rounded ${
            !hasData ? 'bg-gray-800 text-gray-600' :
            isOpen   ? 'bg-green-900/60 text-green-400 border border-green-800' :
                       'bg-red-900/60 text-red-400 border border-red-800'
          }`}
        >
          {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
        </span>
        {mismatch && <span className="text-yellow-400 text-sm">⚠</span>}
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
    <div className="bg-card rounded-lg p-3 flex flex-col gap-1.5">
      <h3 className="text-sm font-bold text-text-muted uppercase tracking-widest mb-0.5">{title}</h3>
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
