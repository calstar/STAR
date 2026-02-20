'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { SystemState, MessageType, CommandPayload, StateUpdate } from '@/lib/types';

const STATE_NAMES: Record<SystemState, string> = {
  [SystemState.DEBUG]: 'DEBUG',
  [SystemState.IDLE]: 'IDLE',
  [SystemState.ARMED]: 'ARMED',
  [SystemState.FUEL_FILL]: 'Fuel FILL',
  [SystemState.OX_FILL]: 'OX FILL',
  [SystemState.GN2_LOW_PRESS]: 'GN2 Low Press',
  [SystemState.GN2_VENT]: 'GN2 Vent',
  [SystemState.FUEL_PRESS]: 'Fuel Press',
  [SystemState.FUEL_VENT]: 'Fuel Vent',
  [SystemState.OX_PRESS]: 'OX Press',
  [SystemState.OX_VENT]: 'OX Vent',
  [SystemState.GN2_HIGH_PRESS]: 'GN2 High Press',
  [SystemState.GN2_HIGH_VENT]: 'GN2 High Vent',
  [SystemState.VENT]: 'VENT',
  [SystemState.CALIBRATE]: 'CALIBRATE',
  [SystemState.READY]: 'READY',
  [SystemState.FIRE]: 'FIRE',
  [SystemState.ABORT]: 'ABORT',
};

interface StateButtonProps {
  state: SystemState;
  label: string;
  isActive: boolean;
  onClick: () => void;
}

function StateButton({ state, label, isActive, onClick }: StateButtonProps) {
  const isEmergency = state === SystemState.ABORT || state === SystemState.VENT;

  return (
    <button
      onClick={onClick}
      className={`
        px-4 py-2 rounded-lg font-semibold transition-all
        ${isActive
          ? 'bg-blue-600 text-white shadow-lg'
          : isEmergency
          ? 'bg-red-600 hover:bg-red-700 text-white'
          : 'bg-card hover:bg-opacity-80 text-text'
        }
      `}
    >
      {label}
    </button>
  );
}

export default function StateMachinePanel() {
  const currentState = useSensorStore((state) => state.currentState);
  const updateState = useSensorStore((state) => state.updateState);
  const ws = getWebSocketClient();

  const sendStateTransition = (targetState: SystemState) => {
    // Optimistic update — show new state immediately
    updateState({ currentState: targetState, stateName: STATE_NAMES[targetState], timestamp: Date.now() });
    const command: CommandPayload = {
      commandType: 'state_transition',
      data: { state: targetState },
    };
    ws.sendCommand(command);
  };

  return (
    <div className="bg-card rounded-lg p-6">
      <h2 className="text-2xl font-bold mb-6">State Machine Control</h2>

      <div className="space-y-3">
        {/* DEBUG/IDLE (horizontal pair) */}
        <div className="flex gap-3">
          <StateButton
            state={SystemState.DEBUG}
            label={STATE_NAMES[SystemState.DEBUG]}
            isActive={currentState === SystemState.DEBUG}
            onClick={() => sendStateTransition(SystemState.DEBUG)}
          />
          <StateButton
            state={SystemState.IDLE}
            label={STATE_NAMES[SystemState.IDLE]}
            isActive={currentState === SystemState.IDLE}
            onClick={() => sendStateTransition(SystemState.IDLE)}
          />
        </div>

        {/* ARMED (single) */}
        <StateButton
          state={SystemState.ARMED}
          label={STATE_NAMES[SystemState.ARMED]}
          isActive={currentState === SystemState.ARMED}
          onClick={() => sendStateTransition(SystemState.ARMED)}
        />

        {/* Fill states (horizontal pair) */}
        <div className="flex gap-3">
          <StateButton
            state={SystemState.FUEL_FILL}
            label={STATE_NAMES[SystemState.FUEL_FILL]}
            isActive={currentState === SystemState.FUEL_FILL}
            onClick={() => sendStateTransition(SystemState.FUEL_FILL)}
          />
          <StateButton
            state={SystemState.OX_FILL}
            label={STATE_NAMES[SystemState.OX_FILL]}
            isActive={currentState === SystemState.OX_FILL}
            onClick={() => sendStateTransition(SystemState.OX_FILL)}
          />
        </div>

        {/* GN2 Low Press/Vent (horizontal pair) */}
        <div className="flex gap-3">
          <StateButton
            state={SystemState.GN2_LOW_PRESS}
            label={STATE_NAMES[SystemState.GN2_LOW_PRESS]}
            isActive={currentState === SystemState.GN2_LOW_PRESS}
            onClick={() => sendStateTransition(SystemState.GN2_LOW_PRESS)}
          />
          <StateButton
            state={SystemState.GN2_VENT}
            label={STATE_NAMES[SystemState.GN2_VENT]}
            isActive={currentState === SystemState.GN2_VENT}
            onClick={() => sendStateTransition(SystemState.GN2_VENT)}
          />
        </div>

        {/* Fuel Press/Vent (horizontal pair) */}
        <div className="flex gap-3">
          <StateButton
            state={SystemState.FUEL_PRESS}
            label={STATE_NAMES[SystemState.FUEL_PRESS]}
            isActive={currentState === SystemState.FUEL_PRESS}
            onClick={() => sendStateTransition(SystemState.FUEL_PRESS)}
          />
          <StateButton
            state={SystemState.FUEL_VENT}
            label={STATE_NAMES[SystemState.FUEL_VENT]}
            isActive={currentState === SystemState.FUEL_VENT}
            onClick={() => sendStateTransition(SystemState.FUEL_VENT)}
          />
        </div>

        {/* OX Press/Vent (horizontal pair) */}
        <div className="flex gap-3">
          <StateButton
            state={SystemState.OX_PRESS}
            label={STATE_NAMES[SystemState.OX_PRESS]}
            isActive={currentState === SystemState.OX_PRESS}
            onClick={() => sendStateTransition(SystemState.OX_PRESS)}
          />
          <StateButton
            state={SystemState.OX_VENT}
            label={STATE_NAMES[SystemState.OX_VENT]}
            isActive={currentState === SystemState.OX_VENT}
            onClick={() => sendStateTransition(SystemState.OX_VENT)}
          />
        </div>

        {/* GN2 High Press/Vent (horizontal pair) */}
        <div className="flex gap-3">
          <StateButton
            state={SystemState.GN2_HIGH_PRESS}
            label={STATE_NAMES[SystemState.GN2_HIGH_PRESS]}
            isActive={currentState === SystemState.GN2_HIGH_PRESS}
            onClick={() => sendStateTransition(SystemState.GN2_HIGH_PRESS)}
          />
          <StateButton
            state={SystemState.GN2_HIGH_VENT}
            label={STATE_NAMES[SystemState.GN2_HIGH_VENT]}
            isActive={currentState === SystemState.GN2_HIGH_VENT}
            onClick={() => sendStateTransition(SystemState.GN2_HIGH_VENT)}
          />
        </div>

        {/* Calibration sequence (vertical) */}
        <StateButton
          state={SystemState.CALIBRATE}
          label={STATE_NAMES[SystemState.CALIBRATE]}
          isActive={currentState === SystemState.CALIBRATE}
          onClick={() => sendStateTransition(SystemState.CALIBRATE)}
        />
        <StateButton
          state={SystemState.READY}
          label={STATE_NAMES[SystemState.READY]}
          isActive={currentState === SystemState.READY}
          onClick={() => sendStateTransition(SystemState.READY)}
        />
        <StateButton
          state={SystemState.FIRE}
          label={STATE_NAMES[SystemState.FIRE]}
          isActive={currentState === SystemState.FIRE}
          onClick={() => sendStateTransition(SystemState.FIRE)}
        />

        {/* Emergency states (bottom) */}
        <StateButton
          state={SystemState.VENT}
          label={STATE_NAMES[SystemState.VENT]}
          isActive={currentState === SystemState.VENT}
          onClick={() => sendStateTransition(SystemState.VENT)}
        />
        <StateButton
          state={SystemState.ABORT}
          label={STATE_NAMES[SystemState.ABORT]}
          isActive={currentState === SystemState.ABORT}
          onClick={() => sendStateTransition(SystemState.ABORT)}
        />
      </div>
    </div>
  );
}

