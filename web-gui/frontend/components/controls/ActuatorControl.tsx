'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { ActuatorId, ActuatorState, CommandPayload } from '@/lib/types';

const ACTUATOR_NAMES: Record<ActuatorId, string> = {
  [ActuatorId.LOX_MAIN]: 'LOX Main',
  [ActuatorId.FUEL_MAIN]: 'Fuel Main',
  [ActuatorId.LOX_VENT]: 'LOX Vent',
  [ActuatorId.FUEL_VENT]: 'Fuel Vent',
  [ActuatorId.LOX_PRESS]: 'LOX Press',
  [ActuatorId.FUEL_PRESS]: 'Fuel Press',
  [ActuatorId.GSE_LOW_VENT]: 'GN2 Vent',
};

interface ActuatorControlProps {
  actuatorId: ActuatorId;
}

export default function ActuatorControl({ actuatorId }: ActuatorControlProps) {
  const ws = getWebSocketClient();
  const getSensorValue = useSensorStore((state) => state.getSensorValue);
  const actuator = useSensorStore((state) => state.actuators.get(actuatorId));

  const entity = `ACT.${ACTUATOR_NAMES[actuatorId].replace(' ', '_')}`;
  const rawAdcCounts = getSensorValue(entity, 'raw_adc_counts') ?? 0;
  const status = getSensorValue(entity, 'status') ?? 0;

  // Determine state from raw ADC counts (simplified - actual logic may vary)
  const isOpen = status === 1 || rawAdcCounts > 1000; // Threshold-based detection

  const sendCommand = (state: ActuatorState) => {
    const command: CommandPayload = {
      commandType: 'actuator',
      data: {
        actuatorId,
        actuatorState: state,
      },
    };

    ws.sendCommand(command);
  };

  return (
    <div className="bg-card rounded-lg p-4 border border-gray-700">
      <h3 className="text-lg font-semibold mb-3">{ACTUATOR_NAMES[actuatorId]}</h3>

      {/* State Display */}
      <div className="mb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-sm text-text-muted">State:</span>
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                isOpen ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="font-medium">{isOpen ? 'OPEN' : 'CLOSED'}</span>
          </div>
        </div>
        <div className="text-xs text-text-muted">
          ADC: {rawAdcCounts.toLocaleString()} | Status: {status}
        </div>
      </div>

      {/* Toggle Buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => sendCommand(ActuatorState.OPEN)}
          className={`
            flex-1 px-4 py-2 rounded-lg font-semibold transition-all
            ${
              isOpen
                ? 'bg-green-600 text-white shadow-lg'
                : 'bg-gray-700 hover:bg-gray-600 text-text'
            }
          `}
        >
          OPEN
        </button>
        <button
          onClick={() => sendCommand(ActuatorState.CLOSED)}
          className={`
            flex-1 px-4 py-2 rounded-lg font-semibold transition-all
            ${
              !isOpen
                ? 'bg-red-600 text-white shadow-lg'
                : 'bg-gray-700 hover:bg-gray-600 text-text'
            }
          `}
        >
          CLOSE
        </button>
      </div>
    </div>
  );
}
