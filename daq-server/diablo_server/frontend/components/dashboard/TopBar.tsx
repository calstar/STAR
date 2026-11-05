'use client'

import { connectionBadge } from '@/lib/connection-badge';
import { useNavigate } from 'react-router-dom';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { startDataCache } from '@/lib/data-cache';
import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { SystemState, CommandPayload, MessageType } from '@/lib/types';
import PressureBar from '@/components/plots/PressureBar';
import { PRESSURE_BAR_SENSORS } from '@/lib/sensor-colors';
import { plotEntityKeysForPressureBar } from '@/lib/sensor-colors';
import NotificationPanel from '@/components/dashboard/NotificationPanel';
import { useControlMode } from '@/lib/control-mode';
import { useSensorConfig } from '@/lib/sensor-config';
import { useGuiConfig } from '@/lib/gui-config';
import { usePressureLimits } from '@/lib/pressure-limits';
import { buildPressureBarDefsFromSensorConfig, type PressureBarDef } from '@/lib/pressure-bar-defs';
import { stateNameUpper, isFireState, stateIdByName, bootStateId } from '@/lib/states';


const STATE_COLORS: Record<number, string> = {
  16: 'text-red-400',
  17: 'text-red-500',
  13: 'text-yellow-400',
  15: 'text-green-400',
  2: 'text-ink',
  0: 'text-ink-3',
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
function ReactivePressureBar({ label, entity, nop, meop, showLimits = true, color, avgEntities }: {
  label: string;
  entity: string;
  nop?: number;
  meop?: number;
  showLimits?: boolean;
  color: string;
  avgEntities?: string[];
}) {
  const togglePressureHistoryPlotVisibility = useSensorStore((s) => s.togglePressureHistoryPlotVisibility);
  const hiddenMap = useSensorStore((s) => s.pressureHistoryHiddenEntities);
  const plotKeys = useMemo(() => plotEntityKeysForPressureBar(entity, avgEntities), [entity, avgEntities]);
  const traceHidden = plotKeys.some((k) => hiddenMap[k]);

  const primaryEntity = avgEntities?.[0] ?? entity;
  const v1 = useSensorValue(primaryEntity, 'pressure_psi');
  const v2 = useSensorValue(avgEntities?.[1] ?? primaryEntity, 'pressure_psi');
  const value = avgEntities && avgEntities.length >= 2 && v1 != null && v2 != null
    ? (v1 + v2) / 2
    : v1;
  return (
    <button
      type="button"
      title={traceHidden ? 'Show this sensor on Pressure History (click)' : 'Hide this sensor from Pressure History (click)'}
      onClick={() => togglePressureHistoryPlotVisibility(plotKeys)}
      className={`min-w-0 h-full overflow-visible flex-1 text-left transition-opacity hover:opacity-95 ${traceHidden ? 'opacity-35' : 'opacity-100'}`}
      style={{ minWidth: '5%', maxWidth: '12%' }}
    >
      <PressureBar
        label={label}
        value={value}
        nop={nop} meop={meop} color={color}
        showLimits={showLimits}
        compact
      />
    </button>
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
  const updateState = useSensorStore((s) => s.updateState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const setDebugMode = useSensorStore((s) => s.setDebugMode);
  const countdownTargetTimeMs = useSensorStore((s) => s.countdownTargetTimeMs);
  const session = useSensorStore((s) => s.session);
  const navigate = useNavigate();
  const { controlEnabled, isOperator, error, unlock, lock } = useControlMode();
  const [showUnlockForm, setShowUnlockForm] = useState(false);

  const connectionStatus = useSensorStore((s) => s.connectionStatus) ?? { connected: false, elodinConnected: false };
  const [clock, setClock] = useState('');
  const [countdown, setCountdown] = useState('---:--:--');
  const [countdownExpired, setCountdownExpired] = useState(false);
  const sensors = useSensorConfig();
  const { pressureBars: barConfig } = useGuiConfig();
  const pressureLimits = usePressureLimits();

  // Top-bar gauges come from config ([[gui.pressure_bars]]) with NOP/MEOP from
  // [pressure_limits]; all three hooks refetch on CONFIG_UPDATED, so edits are live.
  const pressureBars = useMemo(
    () => buildPressureBarDefsFromSensorConfig(sensors, barConfig, pressureLimits),
    [sensors, barConfig, pressureLimits],
  );

  const ws = getWebSocketClient();

  const [countdownMenuOpen, setCountdownMenuOpen] = useState(false);
  const countdownRef = useRef<HTMLDivElement | null>(null);
  const [timeOfDayInput, setTimeOfDayInput] = useState('');
  const [dateTimeInput, setDateTimeInput] = useState('');
  const [hitZeroMode, setHitZeroMode] = useState<'time' | 'datetime'>('time');

  useEffect(() => {
    try {
      startDataCache(); // begin 1 Hz background sampling for plot history
    } catch (err) {
      console.error('[TopBar] Failed to start data cache:', err);
    }
  }, []);

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

  const effectiveState = currentState ?? bootStateId() ?? -1;
  const currentStateName = stateNameUpper(effectiveState);
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';
  const isConnected = connectionStatus.connected;
  const isFullyConnected = connectionStatus.connected && connectionStatus.elodinConnected;
  const isSimulated = !!connectionStatus.simulated;
  // Backend-authoritative "pipeline is actually delivering data" — the badge shows
  // Simulated/Connected only when this is true, so a run marked active but not yet
  // (or no longer) producing data reads "Data Pipeline Down", never a stale badge.
  const dataFresh = !!connectionStatus.dataFresh;
  // Session-enabled deployment with no active run: the pipeline is intentionally
  // down, so show "Session Stopped" rather than a "Data Pipeline Down" alarm.
  const sessionStopped = !!(session?.enabled && !session.active);
  // Dot + label + tooltip, shared with MobileDashboard so the two cannot drift.
  const badge = connectionBadge({
    connected: isConnected,
    sessionStopped,
    dataFresh,
    simulated: isSimulated,
    throttled: connectionStatus.throttled,
    resolutionPct: connectionStatus.resolutionPct,
    lagMs: connectionStatus.lagMs,
  });

  const effectivePressureBars = useMemo(() => {
    if (pressureBars.length > 0) return pressureBars;
    // Fallback before loadPressureBars runs (uses same list as PRESSURE_BAR_SENSORS)
    return PRESSURE_BAR_SENSORS.map((s) => ({
      label: SHORT_LABELS[s.entity] ?? s.label,
      entity: s.entity,
      nop: s.nop,
      meop: s.meop,
      showLimits: true,
      color: s.color,
    })) as PressureBarDef[];
  }, [pressureBars]);

  // Optimistic UI + fire-and-forget; commands run next frame
  const sendState = (state: SystemState) => {
    if (!controlEnabled) return;
    updateState({
      currentState: state,
      stateName: stateNameUpper(state),
      timestamp: Date.now(),
    });
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    requestAnimationFrame(() => ws.sendCommand(cmd));
  };

  // Abort targets by name, from the config's own [[states]]. These were literals — VENT 13,
  // ENGINE_ABORT 17, GSE_ABORT 18, EMERGENCY_ABORT 19 — and a rig on any other numbering has no
  // such ids, so the command resolved to nothing and the button did nothing while looking like it
  // had worked. sendStateNamed() no-ops loudly instead, and hasState() disables a control the
  // config cannot satisfy.
  const sendStateNamed = (name: string) => {
    const id = stateIdByName(name);
    if (id === null) {
      console.error(`[TopBar] config declares no "${name}" state — command not sent`);
      return;
    }
    sendState(id);
  };
  const hasState = (name: string) => stateIdByName(name) !== null;

  const handleEngineAbort = () => {
    sendStateNamed('Vent');
    setTimeout(() => sendStateNamed('Engine Abort'), 5000);
  };

  const handleGseAbort = () => sendStateNamed('GSE Abort');

  const handleEmergencyAbort = () => {
    if (!confirm('⚠️ EMERGENCY ABORT — immediately vent GN2 and abort all operations?')) return;
    sendStateNamed('Emergency Abort');
  };

  const handleExtendFire = () => {
    if (!controlEnabled || !isFireState(currentState)) return;
    const cmd: CommandPayload = { commandType: 'extend_fire', data: {} };
    requestAnimationFrame(() => ws.sendCommand(cmd));
  };

  const countdownControls = (
    <div className="absolute left-0 top-full z-50 mt-2 w-[min(22rem,85vw)] border border-line-strong bg-black p-4 normal-case tracking-normal">
      <div className="caps mb-3 text-[11px]">Countdown</div>

      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={handleAdd30Min} disabled={!controlEnabled} className="ctl h-8 text-[11px]">
          +30 min
        </button>
        <button type="button" onClick={handleSet10Min} disabled={!controlEnabled} className="ctl h-8 text-[11px]">
          Set 10:00
        </button>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <div className="caps text-[11px]">Hit zero at</div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <div className="flex items-center border border-line-strong">
            {(['time', 'datetime'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={!controlEnabled}
                onClick={() => {
                  setHitZeroMode(mode);
                  if (mode === 'time') setDateTimeInput('');
                  else setTimeOfDayInput('');
                }}
                className={`px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  hitZeroMode === mode ? 'bg-ink text-black' : 'text-ink-2 hover:bg-white/10'
                }`}
              >
                {mode === 'time' ? 'Time' : 'Date/Time'}
              </button>
            ))}
          </div>

          {hitZeroMode === 'time' ? (
            <input
              type="text"
              inputMode="numeric"
              placeholder="HH:MM"
              value={timeOfDayInput}
              onChange={(e) => setTimeOfDayInput(e.target.value)}
              className="w-24 border border-line-strong bg-black px-2 py-1 font-mono text-xs text-ink placeholder:text-ink-4"
              disabled={!controlEnabled}
            />
          ) : (
            <input
              type="datetime-local"
              value={dateTimeInput}
              onChange={(e) => setDateTimeInput(e.target.value)}
              className="min-w-[12.5rem] flex-1 border border-line-strong bg-black px-2 py-1 font-mono text-[11px] text-ink"
              disabled={!controlEnabled}
            />
          )}

          <button
            type="button"
            onClick={handleSetHitZeroAt}
            disabled={!controlEnabled}
            className="ctl ml-auto h-7 px-3 text-[11px]"
            title={hitZeroMode === 'datetime' ? 'Set to selected date/time' : 'Set to HH:MM (today or tomorrow)'}
          >
            Set
          </button>
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={() => {
              sendCountdownTarget(null);
              setCountdownMenuOpen(false);
            }}
            disabled={!controlEnabled}
            className="font-mono text-[11px] uppercase tracking-[0.12em] text-ink-3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );

  const lockedTitle = 'Viewer mode: controls locked';

  return (
    <div className="relative select-none">
      {/* ── The status line: connection, session, clocks; the two mode switches at the right.
            One row, never wrapped (as Hotbench's is): the wall clock gives way below 1600 px. */}
      <div className="flex min-h-[44px] flex-nowrap items-center gap-x-7 px-8 py-2 font-mono text-[13px] uppercase tracking-[0.08em] max-[1400px]:gap-x-5 max-[1400px]:px-5">
        <span className="flex flex-shrink-0 items-center gap-2 text-ink-2" title={badge.title}>
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${badge.dotClass}`} />
          {badge.label}
        </span>

        {session?.enabled && (
          <button
            type="button"
            onClick={() => navigate('/session')}
            title="Open session control"
            className={`flex-shrink-0 whitespace-nowrap border px-2.5 py-0.5 text-[11px] tracking-[0.16em] tabular-nums transition-colors ${
              session.active
                ? 'border-green-500 text-green-400 hover:bg-green-900/40'
                : 'border-line-strong text-ink-3 hover:text-ink-2'
            }`}
          >
            {session.active
              ? `Run ${formatCountdown((session.deadlineMs ?? 0) - Date.now()).value}`
              : 'Session stopped'}
          </button>
        )}

        <span className="hidden flex-shrink-0 tabular-nums text-ink-3 min-[1600px]:inline" title="Wall clock">{clock}</span>

        <div ref={countdownRef} className="relative flex flex-shrink-0 items-center gap-2">
          <span className="caps text-[11px]">T−</span>
          <button
            type="button"
            onClick={() => {
              setCountdownMenuOpen((open) => !open);
              if (!timeOfDayInput) {
                const now = new Date();
                setTimeOfDayInput(`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`);
              }
            }}
            className={`font-semibold tabular-nums transition-colors ${
              countdownExpired ? 'text-red-400' : 'text-ink'
            } ${controlEnabled ? 'cursor-pointer hover:text-ink-2' : 'cursor-default'}`}
            title={controlEnabled ? 'Click to adjust countdown' : 'Viewer mode: countdown controls locked'}
          >
            {countdown}
          </button>
          {countdownMenuOpen && countdownControls}
        </div>

        <div className="ml-auto flex flex-shrink-0 items-center gap-3">
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
            className={`ctl h-7 px-3 text-[11px] ${debugMode ? '!border-yellow-500 !text-yellow-400' : ''}`}
            title={controlEnabled ? (debugMode ? 'Debug mode: click to return to safe' : 'Safe mode: click for debug') : lockedTitle}
          >
            {debugMode ? 'Debug' : 'Safe'}
          </button>

          <div className="relative">
            <button
              onClick={() => {
                if (controlEnabled) {
                  lock();
                  setShowUnlockForm(false);
                } else if (isOperator) {
                  unlock();
                } else {
                  setShowUnlockForm((v) => !v);
                }
              }}
              className={`ctl h-7 px-3 text-[11px] ${controlEnabled ? '!border-green-500 !text-green-400' : ''}`}
              title={
                controlEnabled
                  ? 'Controller mode: click to return to viewer'
                  : isOperator
                    ? 'Click to take control'
                    : 'Viewer mode: you are not an approved operator'
              }
            >
              {controlEnabled ? 'Controller' : 'Viewer'}
            </button>

            {!controlEnabled && !isOperator && showUnlockForm && (
              <div className="absolute right-0 top-full z-50 mt-2 flex w-56 flex-col gap-1 border border-line-strong bg-black px-3 py-2 normal-case tracking-normal">
                <span className="text-[11px] text-yellow-400">
                  You&apos;re not an approved operator — control is view-only.
                </span>
                {error && <span className="text-[11px] text-red-400">{error}</span>}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── The strip: the transducers as bars, the board notes, and the command stack. */}
      <div
        className="grid border-t border-line px-8 max-[1400px]:px-5"
        style={{ height: 'max(15vh, 150px)', gridTemplateColumns: 'minmax(0,1fr) minmax(200px,15vw) minmax(280px,330px)' }}
      >
        <section className="flex min-h-0 min-w-0 flex-col py-3 pr-6">
          <h2 className="caps mb-2 flex-shrink-0 text-[11px]" title="Gauge: the stand's transducers and its log files read psig. Hotbench shows psia; add 14.7 to compare.">Pressure · psig</h2>
          <div className="flex min-h-0 flex-1 items-stretch gap-2 overflow-visible">
            {effectivePressureBars.map(({ label, entity, nop, meop, showLimits, color, avgEntities }) => (
              <ReactivePressureBar
                key={entity}
                label={label}
                entity={entity}
                nop={nop}
                meop={meop}
                showLimits={showLimits}
                color={color}
                avgEntities={avgEntities}
              />
            ))}
          </div>
        </section>

        <section className="flex min-h-0 min-w-0 flex-col border-l border-line px-5 py-3">
          <NotificationPanel />
        </section>

        <section className="flex min-h-0 min-w-0 flex-col gap-2 border-l border-line py-3 pl-5">
          <div className="flex flex-shrink-0 items-baseline justify-between gap-3">
            <span className="caps text-[11px]">State</span>
            <span className={`truncate font-mono text-[clamp(14px,1.7vh,22px)] font-bold uppercase tracking-[0.12em] ${stateColor}`}>
              {currentStateName}
            </span>
          </div>

          <button
            onClick={handleEngineAbort}
            disabled={!controlEnabled || !hasState('Vent') || !hasState('Engine Abort')}
            className="ctl min-h-0 flex-[1.3] border-[var(--color-danger)] text-[14px] tracking-[0.34em] text-[var(--color-danger)] hover:!border-[var(--color-danger)] hover:!bg-[var(--color-danger-solid)] hover:!text-white"
            title={
              !controlEnabled
                ? lockedTitle
                : !hasState('Vent') || !hasState('Engine Abort')
                  ? 'Config declares no Vent / Engine Abort state'
                  : 'Vent, then Engine Abort five seconds later'
            }
          >
            Eng Abort
          </button>

          <div className="grid min-h-0 flex-1 grid-cols-3 gap-2">
            <button
              onClick={handleExtendFire}
              disabled={!controlEnabled || !isFireState(currentState)}
              className="ctl text-[10px] tracking-[0.1em] hover:!border-emerald-500 hover:!text-emerald-400"
              title={isFireState(currentState) ? 'Extend fire to 5s from fire start' : 'Only active in FIRE'}
            >
              Extend Fire
            </button>
            <button
              onClick={handleGseAbort}
              disabled={!controlEnabled || !hasState('GSE Abort')}
              className="ctl border-orange-500/70 text-[10px] tracking-[0.1em] text-orange-400 hover:!border-orange-500 hover:!bg-orange-700 hover:!text-white"
              title={
                !controlEnabled
                  ? lockedTitle
                  : !hasState('GSE Abort')
                    ? 'Config declares no GSE Abort state'
                    : undefined
              }
            >
              GSE Abort
            </button>
            <button
              onClick={handleEmergencyAbort}
              disabled={!controlEnabled || !hasState('Emergency Abort')}
              className="ctl border-[var(--color-danger)] text-[10px] tracking-[0.1em] text-[var(--color-danger)] hover:!bg-[var(--color-danger-solid)] hover:!text-white"
              title={
                !controlEnabled
                  ? lockedTitle
                  : !hasState('Emergency Abort')
                    ? 'Config declares no Emergency Abort state'
                    : 'Asks to confirm, then vents GN2 and aborts everything'
              }
            >
              E-Abort
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
