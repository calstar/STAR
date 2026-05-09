'use client'

import { useEffect, useState } from 'react';
import { getWebSocketClient } from '@/lib/websocket';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { useSensorConfig } from '@/lib/sensor-config';
import { useSensorStore } from '@/lib/store';
import { MessageType, SystemState } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { getEntityColor } from '@/lib/sensor-colors';

const DUTY_MIN = 0;
const DUTY_MAX = 100;
const FREQ_MIN = 0.1;
const FREQ_MAX = 1000;
const DURATION_MIN = 0.1;
const DURATION_MAX = 300;

export default function SolenoidCharacterizationPage() {
  const ws = getWebSocketClient();
  const currentState = useSensorStore((s) => s.currentState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const { actuators, loading: actuatorsLoading } = useActuatorsFromConfig();
  const allSensors = useSensorConfig();

  const [actuatorName, setActuatorName] = useState<string>('');
  const [dutyPercent, setDutyPercent] = useState(50);
  const [frequencyHz, setFrequencyHz] = useState(10);
  const [durationSec, setDurationSec] = useState(2);
  const [lastSent, setLastSent] = useState<string | null>(null);
  const [ptEntity, setPtEntity] = useState<string>('');

  const ptSensors = allSensors.filter(
    (s) =>
      ((s.calEntity.startsWith('PT_Cal.') || /^PT\d+_Cal\.CH\d+$/.test(s.calEntity)) ||
        s.calEntity.startsWith('PT.')) &&
      !s.calEntity.includes('RTD')
  );
  const canSendPwm = debugMode || currentState === SystemState.FIRE;

  useEffect(() => {
    if (actuators.length > 0 && !actuatorName) {
      setActuatorName(actuators[0].name);
    }
  }, [actuators, actuatorName]);

  useEffect(() => {
    if (ptSensors.length > 0 && !ptEntity) {
      setPtEntity(ptSensors[0].calEntity);
    }
  }, [ptSensors, ptEntity]);

  const sendPwm = () => {
    if (!actuatorName) return;
    if (!canSendPwm) return;
    const dutyCycle = dutyPercent / 100;
    const durationMs = Math.round(durationSec * 1000);
    ws.sendCommand({
      commandType: 'pwm_actuator',
      data: {
        actuatorName,
        dutyCycle,
        frequency: frequencyHz,
        duration: durationMs,
      },
    });
    setLastSent(`${actuatorName} ${dutyPercent}% @ ${frequencyHz} Hz for ${durationSec}s`);
    setTimeout(() => setLastSent(null), 4000);
  };

  const enableDebugMode = () => {
    ws.sendCommand({ commandType: 'debug_mode', data: { debugMode: true } });
  };

  const selectedPtSensor = ptSensors.find((s) => s.calEntity === ptEntity);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-3">
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="w-1 h-5 bg-amber-500 rounded-full" />
        <h1 className="text-base font-bold text-amber-400 tracking-wider">Solenoid Characterization</h1>
      </div>

      {!canSendPwm && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-amber-900/30 border border-amber-700/50 flex-shrink-0">
          <span className="text-sm text-amber-200">
            PWM commands require <strong>FIRE</strong> state or <strong>Debug mode</strong>. Enable Debug mode to characterize without firing.
          </span>
          <button
            type="button"
            onClick={enableDebugMode}
            className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-black text-sm font-bold"
          >
            Enable Debug Mode
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4 p-4 rounded-lg bg-card border border-gray-800 flex-shrink-0">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-bold text-text-muted uppercase">Actuator</label>
          <select
            value={actuatorName}
            onChange={(e) => setActuatorName(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm min-w-[180px]"
            disabled={actuatorsLoading}
          >
            {actuators.map((a) => (
              <option key={a.entity} value={a.name}>{a.name}</option>
            ))}
            {!actuatorsLoading && actuators.length === 0 && (
              <option value="">No actuators in config</option>
            )}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-bold text-text-muted uppercase">Duty %</label>
          <input
            type="number"
            min={DUTY_MIN}
            max={DUTY_MAX}
            step={1}
            value={dutyPercent}
            onChange={(e) => setDutyPercent(Number(e.target.value))}
            className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm w-24"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-bold text-text-muted uppercase">Frequency (Hz)</label>
          <input
            type="number"
            min={FREQ_MIN}
            max={FREQ_MAX}
            step={0.1}
            value={frequencyHz}
            onChange={(e) => setFrequencyHz(Number(e.target.value))}
            className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm w-28"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-bold text-text-muted uppercase">Duration (s)</label>
          <input
            type="number"
            min={DURATION_MIN}
            max={DURATION_MAX}
            step={0.1}
            value={durationSec}
            onChange={(e) => setDurationSec(Number(e.target.value))}
            className="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm w-24"
          />
        </div>

        <button
          type="button"
          onClick={sendPwm}
          disabled={!canSendPwm || !actuatorName}
          className="px-6 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold text-sm"
        >
          Go
        </button>

        {lastSent && (
          <span className="text-sm text-green-400 font-mono ml-2">Sent: {lastSent}</span>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs font-bold text-text-muted uppercase">Pressure (optional)</span>
          <select
            value={ptEntity}
            onChange={(e) => setPtEntity(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs min-w-[160px]"
          >
            {ptSensors.map((s) => (
              <option key={s.calEntity} value={s.calEntity}>{s.role} ({s.calEntity})</option>
            ))}
          </select>
        </div>
        {selectedPtSensor && (
          <div className="flex-1 min-h-0 bg-card rounded-lg p-2 flex flex-col min-w-0">
            <TimeSeriesPlot
              title={`${selectedPtSensor.role} — Pressure (PSI)`}
              entities={[selectedPtSensor.calEntity]}
              labels={[selectedPtSensor.role]}
              component="pressure_psi"
              colors={[getEntityColor(selectedPtSensor.calEntity)]}
              yLabel="Pressure (PSI)"
            />
          </div>
        )}
      </div>
    </main>
  );
}
