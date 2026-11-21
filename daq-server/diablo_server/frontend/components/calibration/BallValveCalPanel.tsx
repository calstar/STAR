/**
 * Calibration page, Ball valves: each valve's command current -- the mA the board drives for
 * closed and for open, in place of the ideal 4 / 20 (backend/src/ball-valve-current.ts).
 * Type a trial current and "Drive": the board drives the valve at it now, whatever it is
 * commanded. Adjust until the position (shown above it) is fully open or fully closed, then
 * "Save as open" / "Save as closed": that current becomes the state's, and the trial ends.
 *
 * The page no longer captures position endpoints ("Fully closed" / "Fully open", the team,
 * 2026-11-20). A valve that still has stored endpoints (backend/src/ball-valve-cal.ts) shows them
 * and a "Clear position cal" button, so an old calibration is never applied out of sight.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSensorValue } from '@/lib/store';
import { getApiBaseUrl } from '@/lib/websocket';
import { elodinSlotFromBoardId } from '@/lib/sensor-info-entities';

interface Endpoints { closedCounts?: number; openCounts?: number; closedAtMs?: number; openAtMs?: number }
interface ValveCal { entity: string; endpoints: Endpoints | null; liveCounts: number | null; noSignal: boolean }
interface StoredCurrents { entity: string; closedMa?: number; openMa?: number; updatedAtMs?: number }
interface CurrentLimits { minMa: number; maxMa: number; minSpanMa: number }
interface StoredTrial { entity: string; ma: number; expiresAtMs: number }
const DEFAULT_CLOSED_MA = 4;
const DEFAULT_OPEN_MA = 20;
const DEFAULT_LIMITS: CurrentLimits = { minMa: 3.8, maxMa: 20.475, minSpanMa: 1 };

type CurrentAction =
  | { action: 'trial'; ma: number }
  | { action: 'end_trial' }
  | { action: 'save'; as: 'open' | 'closed' }
  | { action: 'clear' };

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Drive the valve at a trial current, watch its position, and save that current as its open or
 * closed. The stored currents (or the ideal 4 / 20) are what the board drives when commanded.
 */
function CommandCurrentRow({ role, entity, stored, trial, limits, onAction, busy, nowMs }: {
  role: string; entity: string; stored?: StoredCurrents; trial?: StoredTrial; limits: CurrentLimits;
  busy: boolean; nowMs: number;
  onAction: (entity: string, body: CurrentAction) => void;
}) {
  const closedMa = stored?.closedMa ?? DEFAULT_CLOSED_MA;
  const openMa = stored?.openMa ?? DEFAULT_OPEN_MA;
  const custom = stored?.closedMa !== undefined;
  const [ma, setMa] = useState((trial?.ma ?? openMa).toFixed(2));
  const v = Number(ma);
  const err = Number.isFinite(v) && v >= limits.minMa && v <= limits.maxMa ? null : `Must be ${limits.minMa}-${limits.maxMa} mA`;
  const running = trial !== undefined && trial.expiresAtMs > nowMs;
  const input = 'ctl h-8 w-20 px-2 text-[12px] font-mono tabular-nums';
  const btn = 'ctl h-8 px-2 text-[11px]';
  return (
    <div className="flex flex-col gap-1.5 pt-1" data-testid={`bv-current:${role}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-bold text-text-muted uppercase tracking-wide">Command current</span>
        <span className="font-mono text-[11px] text-text-muted">
          closed {closedMa.toFixed(2)} mA · open {openMa.toFixed(2)} mA{custom ? '' : ' (ideal)'}
        </span>
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <label className="flex items-center gap-1 text-[11px] text-text-muted">Trial
          <input aria-label={`${role} trial mA`} className={input} type="number" inputMode="decimal"
            step={0.05} min={limits.minMa} max={limits.maxMa} value={ma}
            onChange={(e) => setMa(e.target.value)} />mA</label>
        <button className={btn} disabled={busy || err !== null}
          title="Drive the valve at this current now, whatever it is commanded. Watch % open above."
          onClick={() => onAction(entity, { action: 'trial', ma: v })}>Drive</button>
        {running && (
          <>
            <button className={btn} disabled={busy} title="This trial current becomes the valve's closed current"
              onClick={() => onAction(entity, { action: 'save', as: 'closed' })}>Save as closed</button>
            <button className={btn} disabled={busy} title="This trial current becomes the valve's open current"
              onClick={() => onAction(entity, { action: 'save', as: 'open' })}>Save as open</button>
            <button className={btn} disabled={busy} title="Stop the trial: back to the commanded state's current"
              onClick={() => onAction(entity, { action: 'end_trial' })}>Stop</button>
          </>
        )}
        <button className={btn} disabled={busy || !custom} title="Back to 4 / 20 mA"
          onClick={() => onAction(entity, { action: 'clear' })}>Reset</button>
      </div>
      {running && (
        <p className="text-[11px] text-amber-400" role="status">
          Driving {trial!.ma.toFixed(2)} mA · ends in {fmtLeft(trial!.expiresAtMs - nowMs)} · a command that changes this valve, or the failsafe, ends it on the board: Stop, or Drive a new current, to try again
        </p>
      )}
      {err && <p className="text-[11px] text-amber-400">{err}</p>}
    </div>
  );
}

/** Every actuator role on an enabled BALL_VALVE board, as the calibrated entity it reads. */
export function ballValveRoles(config: Record<string, any> | null): { role: string; entity: string }[] {
  const boards: Record<string, any> = config?.boards ?? {};
  const bvIds = new Set<number>(
    Object.values(boards)
      .filter((b: any) => b?.type === 'BALL_VALVE' && b?.enabled !== false && typeof b?.board_id === 'number')
      .map((b: any) => b.board_id),
  );
  return Object.entries((config?.actuator_roles ?? {}) as Record<string, unknown[]>)
    .filter(([, t]) => Array.isArray(t) && bvIds.has(Number(t[2])))
    .map(([role, t]) => ({ role, entity: `BV${elodinSlotFromBoardId(Number(t[2]))}_Cal.CH${Number(t[1])}` }));
}

function ValveRow({ role, entity, cal, onClear, busy, children }: {
  role: string; entity: string; cal?: ValveCal;
  onClear: (entity: string) => void; busy: boolean;
  children?: React.ReactNode;
}) {
  const pct = useSensorValue(entity, 'position_pct');
  const ep = cal?.endpoints;
  const calibrated = ep?.closedCounts !== undefined || ep?.openCounts !== undefined;
  const live = cal?.noSignal ? 'NO SIGNAL' : pct != null ? `${Math.round(pct)}% open` : '--- %';
  return (
    <div className="px-4 py-3 flex flex-col gap-2" data-testid={`bv-cal:${role}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-text truncate">{role}</span>
        <span className="font-mono text-sm tabular-nums text-text">{live}</span>
      </div>
      <div className="font-mono text-[11px] text-text-muted flex gap-3 flex-wrap items-center">
        <span>raw {cal?.liveCounts ?? '—'}</span>
        {calibrated && (
          <>
            <span>position cal: closed {ep?.closedCounts ?? 'ideal'}, open {ep?.openCounts ?? 'ideal'}</span>
            <button className="ctl h-6 px-2 text-[10px]" disabled={busy}
              title="Forget the stored position endpoints: % open back on the ideal 4-20 mA line"
              onClick={() => onClear(entity)}>Clear position cal</button>
          </>
        )}
      </div>
      {children}
    </div>
  );
}

/** `sessionActive` is accepted for the page's call but unused: nothing here needs the live
 *  stream to act, and config_broadcast, which delivers the currents, runs without a session. */
export function BallValveCalPanel({ config }: { config: Record<string, any> | null; sessionActive?: boolean }) {
  const valves = useMemo(() => ballValveRoles(config), [config]);
  const [cal, setCal] = useState<Record<string, ValveCal>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  const [currents, setCurrents] = useState<Record<string, StoredCurrents>>({});
  const [trials, setTrials] = useState<Record<string, StoredTrial>>({});
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [limits, setLimits] = useState<CurrentLimits>(DEFAULT_LIMITS);

  const adopt = (list: ValveCal[] | undefined) =>
    setCal(Object.fromEntries((list ?? []).map((v) => [v.entity, v])));
  const adoptCurrents = (d: { valves?: StoredCurrents[]; trials?: StoredTrial[]; limits?: CurrentLimits } | null) => {
    if (!d) return;
    setCurrents(Object.fromEntries((d.valves ?? []).map((v) => [v.entity, v])));
    setTrials(Object.fromEntries((d.trials ?? []).map((t) => [t.entity, t])));
    setNowMs(Date.now());
    if (d.limits) setLimits(d.limits);
  };

  useEffect(() => {
    if (valves.length === 0) return;
    let stop = false;
    const poll = () =>
      fetch(`${getApiBaseUrl()}/api/ball_valve_cal`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!stop && d) adopt(d.valves); })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [valves.length]);

  useEffect(() => {
    if (valves.length === 0) return;
    let stop = false;
    const poll = () =>
      fetch(`${getApiBaseUrl()}/api/ball_valve_current`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!stop) adoptCurrents(d); })
        .catch(() => {});
    poll();
    const t = setInterval(poll, 1000);
    return () => { stop = true; clearInterval(t); };
  }, [valves.length]);

  const onCurrentAction = useCallback(async (entity: string, body: CurrentAction) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${getApiBaseUrl()}/api/ball_valve_current`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity, ...body }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d?.error ?? `Not saved (${r.status})`);
      else adoptCurrents(d);
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const onClear = useCallback(async (entity: string) => {
    const action = 'clear';
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${getApiBaseUrl()}/api/ball_valve_cal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entity, action }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) setError(d?.error ?? `Not saved (${r.status})`);
      else adopt(d.valves);
    } catch (e) {
      setError(`Not saved: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, []);

  if (valves.length === 0) return null;
  return (
    <div className="flex-shrink-0 border-t border-gray-800">
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/5">
        <div className="text-left">
          <div className="text-xs font-bold text-text-muted uppercase tracking-wide">Ball valves</div>
          <div className="text-sm text-text-muted mt-1">Command current: closed and open, in mA</div>
        </div>
        <span className="text-gray-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="divide-y divide-gray-800/40 border-t border-gray-800/60">
          {error && <p className="px-4 py-2 text-[12px] text-red-400" role="alert">{error}</p>}
          {valves.map((v) => (
            <ValveRow key={v.entity} role={v.role} entity={v.entity} cal={cal[v.entity]}
              onClear={onClear} busy={busy}>
              <CommandCurrentRow role={v.role} entity={v.entity} stored={currents[v.entity]}
                trial={trials[v.entity]} limits={limits} onAction={onCurrentAction} busy={busy} nowMs={nowMs} />
            </ValveRow>
          ))}
        </div>
      )}
    </div>
  );
}
