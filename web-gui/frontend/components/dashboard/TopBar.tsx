'use client'

import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { startDataCache } from '@/lib/data-cache';
import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { SystemState, CommandPayload, MessageType } from '@/lib/types';
import PressureBar from '@/components/plots/PressureBar';
import { PRESSURE_BAR_SENSORS } from '@/lib/sensor-colors';
import NotificationPanel from '@/components/dashboard/NotificationPanel';
import { useControlMode } from '@/lib/control-mode';
import { useSensorConfig } from '@/lib/sensor-config';
import { buildPressureBarDefsFromSensorConfig, type PressureBarDef } from '@/lib/pressure-bar-defs';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 LOW PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
  20: 'PRESS STANDBY',
};

const STATE_COLORS: Record<number, string> = {
  16: 'text-red-400',
  17: 'text-red-500',
  13: 'text-yellow-400',
  15: 'text-green-400',
  2: 'text-blue-400',
  0: 'text-gray-500',
};

const SHORT_LABELS: Record<string, string> = {
  'PT_Cal.GN2_Regulated': 'GN2 REG', 'PT_Cal.Fuel_Upstream': 'FUEL UP', 'PT_Cal.Fuel_Downstream': 'FUEL DN',
  'PT_Cal.Ox_Upstream': 'LOX UP', 'PT_Cal.Ox_Downstream': 'LOX DN', 'PT_Cal.GSE_Low': 'GSE LO',
  'PT_Cal.GSE_Mid': 'GSE MID', 'PT_Cal.GSE_High': 'GSE HI', 'PT_Cal.GN2_High': 'GN2 HI',
  'PT_Cal.Chamber_Mid_PT_1': 'CHAMBER',
};

// Separate component for each pressure bar to properly use hooks
// Dynamic width: ~9% each with max so bars scale with viewport
// When avgEntities is set, value = average of those entities' pressure_psi
function ReactivePressureBar({ label, entity, nop, meop, color, avgEntities }: {
  label: string;
  entity: string;
  nop?: number;
  meop?: number;
  color: string;
  avgEntities?: string[];
}) {
  const primaryEntity = avgEntities?.[0] ?? entity;
  const v1 = useSensorValue(primaryEntity, 'pressure_psi');
  const v2 = useSensorValue(avgEntities?.[1] ?? primaryEntity, 'pressure_psi');
  const value = avgEntities && avgEntities.length >= 2 && v1 != null && v2 != null
    ? (v1 + v2) / 2
    : v1;
  return (
    <div
      className="min-w-0 h-full overflow-visible flex-1"
      style={{ minWidth: '6%', maxWidth: '14%' }}
    >
      <PressureBar
        label={label}
        value={value}
        nop={nop} meop={meop} color={color}
        compact
      />
    </div>
  );
}

function formatCountdown(valueMs: number): { value: string; expired: boolean } {
  if (!Number.isFinite(valueMs)) return { value: '---:--:--', expired: false };
  if (valueMs <= 0) return { value: '000:00:00', expired: true };
  const totalSecs = Math.floor(valueMs / 1000);
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return {
    value: `${String(h).padStart(3, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
    expired: false,
  };
}

export default function TopBar() {
  // Pressure bars use useSensorValue in ReactivePressureBar — no need to subscribe to full sensorData here
  const currentState = useSensorStore((s) => s.currentState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const setDebugMode = useSensorStore((s) => s.setDebugMode);
  const countdownTargetTimeMs = useSensorStore((s) => s.countdownTargetTimeMs);
  const { controlEnabled, unlocking, error, unlock, lock } = useControlMode();
  const [passwordInput, setPasswordInput] = useState('');
  const [showUnlockForm, setShowUnlockForm] = useState(false);

  const connectionStatus = useSensorStore((s) => s.connectionStatus) ?? { connected: false, elodinConnected: false };
  const [clock, setClock] = useState('');
  const [countdown, setCountdown] = useState('---:--:--');
  const [countdownExpired, setCountdownExpired] = useState(false);
  const [pressureBars, setPressureBars] = useState<PressureBarDef[]>([]);
  const sensors = useSensorConfig();

  const ws = getWebSocketClient();

  const [countdownMenuOpen, setCountdownMenuOpen] = useState(false);
  const countdownRef = useRef<HTMLDivElement | null>(null);
  const [timeOfDayInput, setTimeOfDayInput] = useState('');
  const [dateTimeInput, setDateTimeInput] = useState('');
  const [hitZeroMode, setHitZeroMode] = useState<'time' | 'datetime'>('time');

  const loadPressureBars = useCallback(() => {
    setPressureBars(buildPressureBarDefsFromSensorConfig(sensors));
  }, [sensors]);

  useEffect(() => {
    loadPressureBars();
  }, [loadPressureBars]);

  useEffect(() => {
    ws.connect();
    try {
      startDataCache(); // begin 1 Hz background sampling for plot history
    } catch (err) {
      console.error('[TopBar] Failed to start data cache:', err);
    }
    const unsubConfig = ws.on(MessageType.CONFIG_UPDATED, () => loadPressureBars());
    return () => { unsubConfig(); };
  }, [ws, loadPressureBars]);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const tick = () => {
      if (countdownTargetTimeMs == null) {
        setCountdown('---:--:--');
        setCountdownExpired(false);
        return;
      }
      const diff = countdownTargetTimeMs - Date.now();
      const formatted = formatCountdown(diff);
      setCountdown(formatted.value);
      setCountdownExpired(formatted.expired);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [countdownTargetTimeMs]);

  useEffect(() => {
    if (!countdownMenuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!countdownRef.current?.contains(event.target as Node)) {
        setCountdownMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [countdownMenuOpen]);

  const sendCountdownTarget = useCallback((targetTimeMs: number | null) => {
    if (!controlEnabled) return;
    ws.sendCommand({ commandType: 'set_countdown_target', data: { targetTimeMs } });
  }, [controlEnabled, ws]);

  const handleAdd30Min = useCallback(() => {
    const base = countdownTargetTimeMs ?? Date.now();
    sendCountdownTarget(base + 30 * 60 * 1000);
    setCountdownMenuOpen(false);
  }, [countdownTargetTimeMs, sendCountdownTarget]);

  const handleSet10Min = useCallback(() => {
    sendCountdownTarget(Date.now() + 10 * 60 * 1000);
    setCountdownMenuOpen(false);
  }, [sendCountdownTarget]);

  const handleSetHitZeroAt = useCallback(() => {
    if (hitZeroMode === 'datetime') {
      const rawDateTime = dateTimeInput.trim();
      if (!rawDateTime) return;
      const ms = new Date(rawDateTime).getTime();
      if (!Number.isFinite(ms)) return;
      sendCountdownTarget(ms);
      setCountdownMenuOpen(false);
      return;
    }

    const match = timeOfDayInput.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return;
    const hh = Math.min(23, Math.max(0, parseInt(match[1], 10)));
    const mm = Math.min(59, Math.max(0, parseInt(match[2], 10)));
    const now = new Date();
    const target = new Date(now);
    target.setSeconds(0, 0);
    target.setHours(hh, mm, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    sendCountdownTarget(target.getTime());
    setCountdownMenuOpen(false);
  }, [dateTimeInput, hitZeroMode, sendCountdownTarget, timeOfDayInput]);

  const effectiveState = currentState ?? SystemState.IDLE;
  const currentStateName = STATE_NAMES[effectiveState] ?? `STATE ${effectiveState}`;
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';
  const isConnected = connectionStatus.connected;
  const isFullyConnected = connectionStatus.connected && connectionStatus.elodinConnected;

  const effectivePressureBars = useMemo(() => {
    if (pressureBars.length > 0) return pressureBars;
    // Fallback before loadPressureBars runs (uses same list as PRESSURE_BAR_SENSORS)
    return PRESSURE_BAR_SENSORS.map((s) => ({
      label: SHORT_LABELS[s.entity] ?? s.label,
      entity: s.entity,
      nop: s.nop,
      meop: s.meop,
      color: s.color,
    })) as PressureBarDef[];
  }, [pressureBars]);

  // Fire-and-forget so click feedback is immediate; commands run next frame
  const sendState = (state: SystemState) => {
    if (!controlEnabled) return;
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    requestAnimationFrame(() => ws.sendCommand(cmd));
  };

  const handleEngineAbort = () => {
    sendState(SystemState.VENT);
    setTimeout(() => sendState(SystemState.ENGINE_ABORT), 5000);
  };

  const handleGseAbort = () => sendState(SystemState.GSE_ABORT);

  const handleEmergencyAbort = () => {
    if (!confirm('⚠️ EMERGENCY ABORT — immediately vent GN2 and abort all operations?')) return;
    sendState(SystemState.EMERGENCY_ABORT);
  };

  const handleExtendFire = () => {
    if (!controlEnabled || currentState !== SystemState.FIRE) return;
    const cmd: CommandPayload = { commandType: 'extend_fire', data: {} };
    requestAnimationFrame(() => ws.sendCommand(cmd));
  };

  return (
    <div
      className="relative z-30 bg-card border-b border-gray-800 select-none flex-shrink-0"
      style={{ height: '18vh' }}
    >
      <div className="flex items-stretch h-full px-4 gap-2 py-2">

        {/* Left: brand + connection + clock + countdown */}
        <div className="flex flex-col justify-start gap-1 flex-shrink-0 pr-2 border-r border-gray-800/60">
          <span className="text-3xl font-bold tracking-widest text-blue-400 uppercase leading-none">
            DIABLO DAQ
          </span>
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isFullyConnected ? 'bg-green-500' : isConnected ? 'bg-yellow-500' : 'bg-red-500'}`} />
            <span className="text-sm text-gray-300 font-semibold">
              {isFullyConnected ? 'Connected' : isConnected ? 'WS Only' : 'Disconnected'}
            </span>
          </div>
          <span className="text-xl font-mono text-gray-200 tabular-nums font-bold leading-tight">{clock}</span>
          <div ref={countdownRef} className="relative flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setCountdownMenuOpen((open) => !open);
                if (!timeOfDayInput) {
                  const now = new Date();
                  setTimeOfDayInput(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
                }
              }}
              className={`text-xl font-mono tabular-nums font-bold leading-tight transition ${
                countdownExpired ? 'text-red-400' : 'text-white'
              } ${controlEnabled ? 'cursor-pointer hover:text-blue-300' : 'cursor-default'}`}
              title={controlEnabled ? 'Click to adjust countdown' : 'Viewer mode: countdown controls locked'}
            >
              {countdown}
            </button>

            {countdownMenuOpen && (
              <div className="absolute top-full left-0 z-50 mt-2 w-[min(22rem,85vw)] rounded-xl border border-gray-700 bg-black/90 p-3 shadow-xl">
                <div className="mb-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  Countdown controls
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleAdd30Min}
                    disabled={!controlEnabled}
                    className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    +30 minutes
                  </button>
                  <button
                    type="button"
                    onClick={handleSet10Min}
                    disabled={!controlEnabled}
                    className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Set to 10:00
                  </button>
                </div>

                <div className="mt-3 border-t border-gray-800 pt-3">
                  <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                    Hit zero at
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <div className="flex items-center rounded-lg border border-gray-700 bg-gray-900 p-0.5">
                      <button
                        type="button"
                        disabled={!controlEnabled}
                        onClick={() => {
                          setHitZeroMode('time');
                          setDateTimeInput('');
                        }}
                        className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                          hitZeroMode === 'time'
                            ? 'bg-white text-black'
                            : 'text-gray-200 hover:bg-white/10'
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                      >
                        Time
                      </button>
                      <button
                        type="button"
                        disabled={!controlEnabled}
                        onClick={() => {
                          setHitZeroMode('datetime');
                          setTimeOfDayInput('');
                        }}
                        className={`rounded-md px-2 py-1 text-[11px] font-semibold transition ${
                          hitZeroMode === 'datetime'
                            ? 'bg-white text-black'
                            : 'text-gray-200 hover:bg-white/10'
                        } disabled:opacity-40 disabled:cursor-not-allowed`}
                      >
                        Date/Time
                      </button>
                    </div>

                    {hitZeroMode === 'time' ? (
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="HH:MM"
                        value={timeOfDayInput}
                        onChange={(e) => setTimeOfDayInput(e.target.value)}
                        className="w-24 rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-xs text-white placeholder:text-gray-500"
                        disabled={!controlEnabled}
                      />
                    ) : (
                      <input
                        type="datetime-local"
                        value={dateTimeInput}
                        onChange={(e) => setDateTimeInput(e.target.value)}
                        className="min-w-[12.5rem] flex-1 rounded-md border border-gray-700 bg-black/60 px-2 py-1 text-[11px] text-white"
                        disabled={!controlEnabled}
                      />
                    )}

                    <button
                      type="button"
                      onClick={handleSetHitZeroAt}
                      disabled={!controlEnabled}
                      className="ml-auto rounded-md border border-gray-700 bg-gray-900 px-2 py-1 text-xs font-semibold text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={hitZeroMode === 'datetime' ? 'Set to selected date/time' : 'Set to HH:MM (today or tomorrow)'}
                    >
                      Set
                    </button>
                  </div>

                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        sendCountdownTarget(null);
                        setCountdownMenuOpen(false);
                      }}
                      disabled={!controlEnabled}
                      className="text-[11px] font-semibold text-gray-300 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Middle: notifications */}
        <div className="flex flex-col justify-center pr-1 flex-shrink-0 w-[15vw]">
          <NotificationPanel />
        </div>

        {/* Center: pressure bars — dynamic spacing, scales with viewport */}
        <div className="flex-[2] flex items-stretch justify-end gap-4 sm:gap-6 lg:gap-8 min-w-0 overflow-visible" style={{ maxWidth: '60vw' }}>
          {effectivePressureBars.map(({ label, entity, nop, meop, color, avgEntities }) => (
            <ReactivePressureBar
              key={entity}
              label={label}
              entity={entity}
              nop={nop}
              meop={meop}
              color={color}
              avgEntities={avgEntities}
            />
          ))}
        </div>

        {/* Right: state + mode + abort — top-right aligned; min width so buttons don't clip */}
        <div className="w-full max-w-[320px] min-w-[260px] flex items-stretch justify-between gap-2 flex-shrink-0 pl-3 border-l border-gray-800/60 ml-auto">
          <div className="flex flex-col justify-center items-center gap-2 flex-1 min-w-0">
            <span className="text-[10px] xl:text-sm text-gray-400 uppercase tracking-widest font-bold text-center">STATE</span>
            <span className={`text-lg xl:text-2xl font-bold font-mono tracking-wider text-center leading-tight whitespace-normal ${stateColor}`}>
              {currentStateName}
            </span>
          </div>

          {/* Control lock + debug mode stacked */}
          <div className="flex flex-col items-stretch justify-center gap-2 flex-1 min-w-0 relative border-l border-gray-800/60 pl-2">
            <button
              onClick={() => {
                if (!controlEnabled) return;
                const newDebugMode = !debugMode;
                startTransition(() => setDebugMode(newDebugMode));
                const cmd: CommandPayload = {
                  commandType: 'debug_mode',
                  data: { debugMode: newDebugMode }
                };
                requestAnimationFrame(() => ws.sendCommand(cmd));
              }}
              disabled={!controlEnabled}
              className={`w-full py-2 xl:py-4 rounded-xl text-[10px] xl:text-sm font-bold uppercase tracking-wider border transition-all text-center ${debugMode
                  ? controlEnabled
                    ? 'bg-yellow-800/60 border-yellow-600 text-yellow-300 shadow-[0_0_6px_rgba(234,179,8,0.3)]'
                    : 'bg-yellow-900/40 border-yellow-800 text-yellow-700 cursor-not-allowed'
                  : controlEnabled
                    ? 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-500'
                    : 'bg-gray-900 border-gray-800 text-gray-700 cursor-not-allowed'
                }`}
              title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
            >
              {debugMode ? '🔓 DEBUG' : '🔒 SAFE'}
            </button>

            <button
              onClick={() => {
                if (controlEnabled) {
                  lock();
                  setShowUnlockForm(false);
                  setPasswordInput('');
                } else {
                  setShowUnlockForm((v) => !v);
                }
              }}
              className={`justify-center w-full py-2 xl:py-4 rounded-xl text-[10px] xl:text-sm font-semibold uppercase tracking-wider border flex ${controlEnabled
                  ? 'border-green-500 bg-green-900/40 text-green-300 hover:bg-green-800/60'
                  : 'border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800'
                }`}
            >
              {controlEnabled ? 'CONTROLLER' : 'VIEWER'}
            </button>

            {!controlEnabled && showUnlockForm && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  unlock(passwordInput);
                }}
                className="absolute top-full right-0 mt-1 flex flex-col gap-1 bg-background border border-gray-700 rounded px-2 py-2 shadow-lg z-50 w-48"
              >
                <input
                  type="password"
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Control password"
                  className="px-2 py-1 rounded bg-black/60 border border-gray-700 text-[11px] text-white"
                />
                <button
                  type="submit"
                  disabled={unlocking || !passwordInput}
                  className="px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wider border border-blue-700 bg-blue-700/80 hover:bg-blue-600 disabled:opacity-50"
                >
                  {unlocking ? 'Unlocking…' : 'Submit'}
                </button>
                {error && (
                  <span className="text-[10px] text-red-400">
                    {error}
                  </span>
                )}
              </form>
            )}
          </div>

          {/* Extend Fire + Abort buttons — min width so label isn't clipped */}
          <div className="flex flex-col justify-center gap-2 flex-1 min-w-[7.25rem] border-l border-gray-800/60 pl-2">
            <button
              onClick={handleExtendFire}
              disabled={!controlEnabled || currentState !== SystemState.FIRE}
              className="w-full min-w-0 py-2 xl:py-3 bg-emerald-800 hover:bg-emerald-700 active:bg-emerald-900 border border-emerald-600
                         text-white font-semibold text-[10px] xl:text-xs rounded-xl tracking-wider transition-colors disabled:bg-gray-800 disabled:border-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed"
              title={currentState === SystemState.FIRE ? 'Extend fire to 5s from fire start' : 'Only active in FIRE'}
            >
              EXTEND FIRE
            </button>
            <button
              onClick={handleEngineAbort}
              disabled={!controlEnabled}
              className="w-full py-2 xl:py-3 bg-amber-800 hover:bg-amber-700 active:bg-amber-900 border border-amber-600
                         text-white font-semibold text-[10px] xl:text-xs rounded-xl tracking-wider transition-colors disabled:bg-amber-900 disabled:border-amber-900 disabled:text-amber-700 disabled:cursor-not-allowed"
              title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
            >
              ENG ABORT
            </button>
            <button
              onClick={handleGseAbort}
              disabled={!controlEnabled}
              className="w-full py-2 xl:py-3 bg-orange-800 hover:bg-orange-700 active:bg-orange-900 border border-orange-600
                         text-white font-semibold text-[10px] xl:text-xs rounded-xl tracking-wider transition-colors disabled:bg-orange-900 disabled:border-orange-900 disabled:text-orange-700 disabled:cursor-not-allowed"
              title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
            >
              GSE ABORT
            </button>
            <button
              onClick={handleEmergencyAbort}
              disabled={!controlEnabled}
              className="w-full py-2 xl:py-3 bg-red-700 hover:bg-red-600 active:bg-red-800 border border-red-500
                         text-white font-semibold text-[10px] xl:text-xs rounded-xl tracking-wider transition-colors
                         shadow-[0_0_6px_rgba(239,68,68,0.4)] disabled:bg-red-900 disabled:border-red-900 disabled:text-red-700 disabled:cursor-not-allowed"
              title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
            >
              E-ABORT
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
