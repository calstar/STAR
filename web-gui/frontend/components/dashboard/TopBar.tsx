'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { useEffect, useState } from 'react';
import { MessageType, ConnectionStatus } from '@/lib/types';
import PressureBar from '@/components/plots/PressureBar';

interface PressureGaugeProps {
  label: string;
  value: number | null;
  color: string;
  unit?: string;
}

function PressureGauge({ label, value, color, unit = 'PSI' }: PressureGaugeProps) {
  const displayValue = value !== null ? value.toFixed(1) : '---';

  return (
    <div className="flex flex-col items-center p-4 bg-card rounded-lg">
      <div className="text-sm text-text-muted mb-1">{label}</div>
      <div className={`text-3xl font-bold`} style={{ color }}>
        {displayValue}
      </div>
      <div className="text-xs text-text-muted">{unit}</div>
    </div>
  );
}

export default function TopBar() {
  const getSensorValue = useSensorStore((state) => state.getSensorValue);
  const currentState = useSensorStore((state) => state.currentState);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    elodinConnected: false,
  });

  const ws = getWebSocketClient();

  const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);

  useEffect(() => {
    ws.connect();
    const unsubscribe = ws.onConnectionStatus((status) => {
      setConnectionStatus(status);
      updateConnectionStatus(status);
    });

    return unsubscribe;
  }, [ws, updateConnectionStatus]);

  const stateNames: Record<number, string> = {
    0: 'DEBUG',
    1: 'IDLE',
    2: 'ARMED',
    3: 'FUEL FILL',
    4: 'OX FILL',
    5: 'GN2 LOW PRESS',
    6: 'GN2 VENT',
    7: 'FUEL PRESS',
    8: 'FUEL VENT',
    9: 'OX PRESS',
    10: 'OX VENT',
    11: 'GN2 HIGH PRESS',
    12: 'GN2 HIGH VENT',
    13: 'VENT',
    14: 'CALIBRATE',
    15: 'READY',
    16: 'FIRE',
    17: 'ABORT',
  };

  const currentStateName = currentState !== null ? stateNames[currentState] : 'UNKNOWN';

  return (
    <div className="bg-card border-b border-gray-700 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Pressure Bars (NOP/MEOP) */}
        <div className="flex gap-4 justify-center mb-4">
          <PressureBar
            label="GN2"
            value={getSensorValue('PT_Cal.GN2_Regulated', 'pressure_psi')}
            nop={900}
            meop={950}
            color="#27AE60"
            height={120}
          />
          <PressureBar
            label="FUEL"
            value={getSensorValue('PT_Cal.Fuel_Upstream', 'pressure_psi')}
            nop={600}
            meop={650}
            color="#3498DB"
            height={120}
          />
          <PressureBar
            label="LOX"
            value={getSensorValue('PT_Cal.Ox_Upstream', 'pressure_psi')}
            nop={600}
            meop={650}
            color="#E74C3C"
            height={120}
          />
          <PressureBar
            label="GSE Low"
            value={getSensorValue('PT_Cal.GSE_Low', 'pressure_psi')}
            nop={500}
            meop={700}
            color="#F39C12"
            height={120}
          />
          <PressureBar
            label="GSE Mid"
            value={getSensorValue('PT_Cal.GSE_Mid', 'pressure_psi')}
            nop={500}
            meop={700}
            color="#9B59B6"
            height={120}
          />
          <PressureBar
            label="GSE High"
            value={getSensorValue('PT_Cal.GSE_High', 'pressure_psi') || getSensorValue('PT_Cal.PT_CH8', 'pressure_psi')}
            nop={500}
            meop={700}
            color="#8E44AD"
            height={120}
          />
          <PressureBar
            label="GN2 High"
            value={getSensorValue('PT_Cal.GN2_High', 'pressure_psi') || getSensorValue('PT_Cal.PT_CH8', 'pressure_psi')}
            nop={900}
            meop={950}
            color="#27AE60"
            height={120}
          />
        </div>

        <div className="flex items-center justify-between">
          {/* Status Section */}
          <div className="flex items-center gap-6">
            <div className="text-right">
              <div className="text-sm text-text-muted">Current State</div>
              <div className="text-2xl font-bold">{currentStateName}</div>
            </div>

            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  connectionStatus.connected && connectionStatus.elodinConnected
                    ? 'bg-green-500'
                    : 'bg-red-500'
                }`}
              />
              <span className="text-sm">
                {connectionStatus.connected && connectionStatus.elodinConnected
                  ? 'Connected'
                  : 'Disconnected'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
