'use client'

import { useMemo } from 'react';
import { useSensorStore, useGetSensorValue, useSensorDataVersion, useActuatorCommandedState } from '@/lib/store';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { BoardStatus, engineStateCodeToLabel, ActuatorState } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { PRESSURE_SENSORS } from '@/lib/sensor-colors';

/** Display follows commanded state only (state machine / user command); no ADC. */
function ActuatorStatusRow({ label, entity }: { label: string; entity: string }) {
  const commanded = useActuatorCommandedState(entity);
  const isOpen = commanded === ActuatorState.OPEN;
  const hasState = commanded === ActuatorState.OPEN || commanded === ActuatorState.CLOSED;
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
      <span className="text-base font-semibold text-text">{label}</span>
      <span className={`text-base font-bold font-mono px-3 py-1 rounded ${!hasState ? 'bg-gray-800 text-gray-600' : isOpen ? 'bg-green-900/60 text-green-400' : 'bg-red-900/60 text-red-400'}`}>
        {!hasState ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
      </span>
    </div>
  );
}

const HP_PT_SENSORS = PRESSURE_SENSORS.filter((s) =>
  ['PT_Cal.GSE_Mid', 'PT_Cal.GSE_High', 'PT_Cal.GN2_High'].includes(s.entity)
).map(({ label, entity, color }) => ({ label, entity, color }));

interface StacklightState {
  red: boolean;
  yellow: boolean;
  green: boolean;
  buzzer: boolean;
}

/**
 * Mirrors stateToStacklight() in
 * daq-server/diablo_server/services/stacklight/stacklight_service_main.cpp
 * Keep these two in sync manually — no shared source of truth yet.
 */
function sequencerStateToStacklight(state: number | null): StacklightState {
  const off: StacklightState = { red: false, yellow: false, green: false, buzzer: false };
  if (state === null) return off;

  switch (state) {
    case 1: // IDLE
      return { ...off, green: true };
    case 0: // DEBUG
    case 14: // CALIBRATE
    case 6: case 8: case 10: case 12: case 13: // VENT states
      return { ...off, yellow: true };
    case 2: // ARMED
    case 15: // READY
    case 20: // PRESS_STANDBY
      return { ...off, red: true, yellow: true };
    case 3: case 4: // FUEL_FILL, OX_FILL
    case 5: case 7: case 9: case 11: // PRESS states
      return { ...off, red: true };
    case 16: // FIRE
      return { ...off, red: true, buzzer: true };
    case 17: case 18: case 19: // ABORT states
      return { ...off, red: true, buzzer: true };
    default: // UNKNOWN
      return { red: true, yellow: true, green: true, buzzer: true };
  }
}

function fmtValue(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

export default function StatusPage() {
  const boardsMap = useSensorStore((s) => s.boards);
  const currentState = useSensorStore((s) => s.currentState);
  const { actuators } = useActuatorsFromConfig();
  const ACTUATORS = actuators.map((a) => ({ label: a.name, entity: a.entity, channel: a.channel }));
  useSensorDataVersion(); // re-render on sensor flush so getSensorValue() shows fresh data
  const getSensorValue = useGetSensorValue();

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

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Pressure Sensors */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Pressure Sensors</h2>
          <div className="space-y-2">
            {PRESSURE_SENSORS.map((s) => {
              const value = getSensorValue(s.entity, s.component);
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

        {/* Actuators — display follows state machine diagram (expected for current state) */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Actuators</h2>
          <div className="space-y-2">
            {ACTUATORS.map((a) => (
              <ActuatorStatusRow key={a.label} label={a.label} entity={a.entity} />
            ))}
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
                const isOperational = b.operational ?? b.connected;
                const statusColor =
                  !isOperational ? 'bg-red-900/60 text-red-400' : 'bg-green-900/60 text-green-400';
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
                    className="flex flex-col gap-1 py-2 px-3 rounded border border-gray-800"
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
                            className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase tracking-wide font-mono ${b.configured
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
                          {isOperational ? 'CONNECTED' : 'DISCONNECTED'}
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

        {/* Stacklight */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Stacklight</h2>
          {(() => {
            const light = sequencerStateToStacklight(currentState);
            const dot = (on: boolean, color: string) =>
              `w-8 h-8 rounded-full border-2 border-gray-700 ${on ? color : 'bg-gray-900'}`;
            return (
              <div className="flex items-center justify-around py-4">
                <div className="flex flex-col items-center gap-2">
                  <div className={dot(light.red, 'bg-red-500 shadow-[0_0_12px_2px_rgba(239,68,68,0.7)]')} />
                  <span className="text-xs text-text-muted font-mono uppercase">Red</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className={dot(light.yellow, 'bg-yellow-400 shadow-[0_0_12px_2px_rgba(250,204,21,0.7)]')} />
                  <span className="text-xs text-text-muted font-mono uppercase">Yellow</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className={dot(light.green, 'bg-green-500 shadow-[0_0_12px_2px_rgba(34,197,94,0.7)]')} />
                  <span className="text-xs text-text-muted font-mono uppercase">Green</span>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <div className={`text-2xl ${light.buzzer ? 'text-amber-400 animate-pulse' : 'text-gray-700'}`}>🔊</div>
                  <span className="text-xs text-text-muted font-mono uppercase">Buzzer</span>
                </div>
              </div>
            );
          })()}
        </div>
       </div>	

      {/* High Pressure PT Sensors Section */}
      <div className="mt-4">
        <h2 className="text-xl font-bold text-text-muted uppercase tracking-wider mb-4">High Pressure PT Sensors</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {HP_PT_SENSORS.map((sensor) => {
            const pressure = getSensorValue(sensor.entity, 'pressure_psi');
            const adc = getSensorValue(sensor.entity, 'raw_adc_counts');
            const vExc = getSensorValue(sensor.entity, 'excitation_voltage');
            const vSense = getSensorValue(sensor.entity, 'sense_voltage');
            const current = getSensorValue(sensor.entity, 'current_ma');

            return (
              <div key={sensor.label} className="bg-card rounded-lg p-4 border border-gray-800">
                <h3 className="text-lg font-bold text-text mb-3 flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: sensor.color }} />
                  {sensor.label}
                </h3>

                {/* Current Values */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Pressure</div>
                    <div className="text-xl font-bold font-mono tabular-nums" style={{ color: sensor.color }}>
                      {fmtValue(pressure)} PSI
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Current</div>
                    <div className="text-xl font-bold font-mono tabular-nums text-blue-400">
                      {current !== null ? `${current.toFixed(2)} mA` : '---'}
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">V_exc</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-green-400">
                      {vExc !== null ? `${vExc.toFixed(3)} V` : '---'}
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">V_sense</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-yellow-400">
                      {vSense !== null ? `${vSense.toFixed(3)} V` : '---'}
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2 col-span-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">ADC Code</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-purple-400">
                      {adc !== null ? adc.toLocaleString() : '---'}
                    </div>
                  </div>
                </div>

                {/* Time Series Plots */}
                <div className="space-y-3">
                  <div className="h-32">
                    <TimeSeriesPlot
                      title="Voltage"
                      entities={[sensor.entity]}
                      component="excitation_voltage"
                      components={['excitation_voltage', 'sense_voltage']}
                      labels={['V_exc', 'V_sense']}
                      colors={['#27AE60', '#F39C12']}
                      yLabel="Voltage (V)"
                      height={128}
                      windowSeconds={60}
                    />
                  </div>
                  <div className="h-32">
                    <TimeSeriesPlot
                      title="Current"
                      entities={[sensor.entity]}
                      component="current_ma"
                      components={['current_ma']}
                      labels={['Current']}
                      colors={[sensor.color]}
                      yLabel="Current (mA)"
                      height={128}
                      windowSeconds={60}
                    />
                  </div>
                  <div className="h-32">
                    <TimeSeriesPlot
                      title="ADC Code"
                      entities={[sensor.entity]}
                      component="raw_adc_counts"
                      components={['raw_adc_counts']}
                      labels={['ADC']}
                      colors={['#9B59B6']}
                      yLabel="ADC Code"
                      height={128}
                      windowSeconds={60}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
