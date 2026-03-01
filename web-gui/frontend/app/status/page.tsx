'use client'

import { useEffect, useMemo } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, BoardStatusPayload, BoardStatus, engineStateCodeToLabel } from '@/lib/types';

const PRESSURE_SENSORS = [
  { label: 'GN2 Regulated', entity: 'PT_Cal.GN2_Regulated', component: 'pressure_psi', color: '#27AE60', nop: 900, meop: 950 },
  { label: 'Fuel Upstream', entity: 'PT_Cal.Fuel_Upstream', component: 'pressure_psi', color: '#3498DB', nop: 600, meop: 650 },
  { label: 'Fuel Downstream', entity: 'PT_Cal.Fuel_Downstream', component: 'pressure_psi', color: '#2980B9', nop: 600, meop: 650 },
  { label: 'LOX Upstream', entity: 'PT_Cal.Ox_Upstream', component: 'pressure_psi', color: '#E74C3C', nop: 600, meop: 650 },
  { label: 'LOX Downstream', entity: 'PT_Cal.Ox_Downstream', component: 'pressure_psi', color: '#C0392B', nop: 600, meop: 650 },
  { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', component: 'pressure_psi', color: '#F39C12', nop: 500, meop: 700 },
  { label: 'GSE Mid', entity: 'PT_Cal.GSE_Mid', component: 'pressure_psi', color: '#9B59B6', nop: 500, meop: 700 },
  { label: 'GSE High', entity: 'PT_Cal.GSE_High', component: 'pressure_psi', color: '#8E44AD', nop: 500, meop: 700 },
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', component: 'pressure_psi', color: '#1ABC9C', nop: 900, meop: 950 },
];

const ACTUATORS = [
  { label: 'LOX Main', entity: 'ACT.LOX_Main' },
  { label: 'Fuel Main', entity: 'ACT.Fuel_Main' },
  { label: 'LOX Vent', entity: 'ACT.LOX_Vent' },
  { label: 'Fuel Vent', entity: 'ACT.Fuel_Vent' },
  { label: 'LOX Press', entity: 'ACT.LOX_Press' },
  { label: 'Fuel Press', entity: 'ACT.Fuel_Press' },
  { label: 'GSE Low Vent', entity: 'ACT.GSE_Low_Vent' },
];

function fmtValue(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

export default function StatusPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateBoards = useSensorStore((s) => s.updateBoards);
  const boardsMap = useSensorStore((s) => s.boards);
  const currentState = useSensorStore((s) => s.currentState);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsubBoards = ws.on(MessageType.BOARD_STATUS_UPDATE, (p: unknown) => {
      const payload = p as BoardStatusPayload;
      if (payload && Array.isArray(payload.boards)) {
        updateBoards(payload.boards as BoardStatus[]);
      }
    });
    return () => {
      unsubSensor();
      unsubBoards();
    };
  }, [ws, updateSensor, updateBoards]);

  const boards = useMemo(() => {
    return Object.values(boardsMap).sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      const an = a.boardNumber ?? Number.MAX_SAFE_INTEGER;
      const bn = b.boardNumber ?? Number.MAX_SAFE_INTEGER;
      if (an !== bn) return an - bn;
      return a.id - b.id;
    });
  }, [boardsMap]);

  const stateNames: Record<number, string> = {
    0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
    5: 'GN2 PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
    9: 'OX PRESS', 10: 'OX VENT', 11: 'HIGH PRESS', 12: 'HIGH VENT',
    13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
  };

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-auto p-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-text mb-1">System Status</h1>
        <div className="text-lg font-mono">
          State: <span className="font-bold">{currentState != null ? stateNames[currentState] ?? 'UNKNOWN' : '---'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Pressure Sensors */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Pressure Sensors</h2>
          <div className="space-y-2">
            {PRESSURE_SENSORS.map((s) => {
              const value = useSensorValue(s.entity, s.component);
              const val = value ?? null;
              const statusColor = val !== null && val > (s.meop ?? 0) ? '#E74C3C' :
                                 val !== null && val > (s.nop ?? 0) ? '#F39C12' : s.color;
              return (
                <div key={s.label} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="text-base font-semibold text-text">{s.label}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    {s.nop && s.meop && (
                      <div className="text-xs text-gray-500 font-mono">
                        NOP: {s.nop} | MEOP: {s.meop}
                      </div>
                    )}
                    <span className="text-xl font-bold font-mono tabular-nums" style={{ color: statusColor }}>
                      {fmtValue(val)} PSI
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actuators */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Actuators</h2>
          <div className="space-y-2">
            {ACTUATORS.map((a) => {
              const status = useSensorValue(a.entity, 'status');
              const adc = useSensorValue(a.entity, 'raw_adc_counts');
              const isOpen = status === 1 || (adc !== null && adc > 1000);
              const hasData = status !== null || adc !== null;
              return (
                <div key={a.label} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <span className="text-base font-semibold text-text">{a.label}</span>
                  <div className="flex items-center gap-3">
                    {hasData && (
                      <span className="text-sm font-mono text-gray-500">
                        ADC: {adc?.toLocaleString() ?? '---'}
                      </span>
                    )}
                    <span
                      className={`text-base font-bold font-mono px-3 py-1 rounded ${
                        !hasData ? 'bg-gray-800 text-gray-600' :
                        isOpen ? 'bg-green-900/60 text-green-400' : 'bg-red-900/60 text-red-400'
                      }`}
                    >
                      {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Boards / Heartbeats */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Boards / Heartbeats</h2>
          {boards.length === 0 ? (
            <div className="text-sm text-text-muted">No boards configured or discovered yet.</div>
          ) : (
            <div className="space-y-2">
              {boards.map((b) => {
                const statusColor =
                  !b.connected ? 'bg-red-900/60 text-red-400' : 'bg-green-900/60 text-green-400';
                const unexpectedBg = b.expected ? '' : 'bg-amber-900/20';
                const freq =
                  b.frequencyHz != null && isFinite(b.frequencyHz)
                    ? `${b.frequencyHz.toFixed(1)} Hz`
                    : '---';

                let boardStateLabel = 'Unknown';
                if (b.boardState === 1) boardStateLabel = 'Setup';
                else if (b.boardState === 2) boardStateLabel = 'Active';
                else if (b.boardState === 3) boardStateLabel = 'Abort';
                else if (b.boardState === 4) boardStateLabel = 'Abort done';

                const engineLabel = engineStateCodeToLabel(b.engineState);

                const nameParts = [];
                if (b.type) nameParts.push(b.type);
                if (b.boardNumber != null) nameParts.push(`Board ${b.boardNumber}`);
                const title = nameParts.join(' · ') || `ID ${b.id}`;

                return (
                  <div
                    key={b.id}
                    className={`flex flex-col gap-1 py-2 px-3 rounded border border-gray-800 ${unexpectedBg}`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="text-base font-semibold text-text">
                          {title}
                        </span>
                        <span className="text-xs text-text-muted font-mono">
                          ID {b.id} • {b.ip}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {!b.expected && (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-amber-900/60 text-amber-200 font-semibold uppercase tracking-wide">
                            Unexpected
                          </span>
                        )}
                        {b.designatedSurvivor && (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-blue-900/60 text-blue-200 font-semibold uppercase tracking-wide">
                            Designated
                          </span>
                        )}
                        {b.necessaryForAbort && (
                          <span className="text-[10px] px-2 py-0.5 rounded bg-red-900/60 text-red-200 font-semibold uppercase tracking-wide">
                            Abort-critical
                          </span>
                        )}
                        {b.configured !== undefined && (
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase tracking-wide font-mono ${
                              b.configured
                                ? 'bg-emerald-900/60 text-emerald-200'
                                : 'bg-gray-800 text-gray-500'
                            }`}
                          >
                            {b.configured ? 'Config OK' : 'Unconfigured'}
                          </span>
                        )}
                        <span
                          className={`text-xs font-bold font-mono px-2 py-1 rounded ${statusColor}`}
                        >
                          {b.connected ? 'CONNECTED' : 'DISCONNECTED'}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-text-muted font-mono">
                      <span>Heartbeat: {freq}</span>
                      <span>
                        State: {boardStateLabel} · Engine: {engineLabel}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
