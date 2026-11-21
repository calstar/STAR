/**
 * Calibration page, Ball valves: each valve's command current -- the mA the board drives for
 * closed and for open, in place of the ideal 4 / 20 (backend/src/ball-valve-current.ts).
 * Type a trial current and "Drive": the board drives the valve at it now, whatever it is
 * commanded. Adjust until the position (shown above it) is fully open or fully closed, then
 * "Save as open" / "Save as closed": that current becomes the state's, and the trial ends.
 *
 * Step 2, position: with the valve driven at its saved closed current, "Record as 0%" stores the
 * feedback (FB) reading as fully closed; at its open current, "Record as 100%" stores fully open.
 * % open is then a straight line between those two feedback readings
 * (backend/src/ball-valve-cal.ts) instead of the ideal 4-20 mA line.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSensorValue } from '@/lib/store';
import { getApiBaseUrl } from '@/lib/websocket';
import { elodinSlotFromBoardId } from '@/lib/sensor-info-entities';
import { loopMilliamps } from '@/lib/ball-valve';

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
type EndpointAction = 'closed' | 'open' | 'clear';

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
  const input = 'ctl h-10 w-28 px-3 text-[14px] font-mono tabular-nums';
  const btn = 'ctl h-10 px-4 text-[12px]';
  return (
    <div className="rounded-xl border border-gray-700 bg-card p-5 flex flex-col gap-3" data-testid={`bv-current:${role}`}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="text-sm font-bold text-text">Step 1 · Command current: set the open and closed current</span>
        <span className="font-mono text-sm text-text-muted">
          closed {closedMa.toFixed(2)} mA · open {openMa.toFixed(2)} mA{custom ? '' : ' (ideal)'}
        </span>
      </div>
      <div className="flex gap-3 items-center flex-wrap">
        <label className="flex items-center gap-2 text-sm text-text-muted">Trial
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
        <p className="text-sm text-amber-400" role="status">
          Driving {trial!.ma.toFixed(2)} mA · ends in {fmtLeft(trial!.expiresAtMs - nowMs)}
        </p>
      )}
      {err && <p className="text-sm text-amber-400">{err}</p>}
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

function ValveRow({ role, entity, cal, busy, onClearAll, children }: {
  role: string; entity: string; cal?: ValveCal; busy: boolean;
  onClearAll: (entity: string, role: string) => void;
  children?: React.ReactNode;
}) {
  const pct = useSensorValue(entity, 'position_pct');
  const live = cal?.noSignal ? 'NO SIGNAL' : pct != null ? `${Math.round(pct)}% open` : '--- %';
  return (
    <div className="flex flex-col gap-6" data-testid={`bv-cal:${role}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-3xl font-bold text-text tracking-tight">{role}</h2>
          <div className="text-sm text-text-muted font-mono mt-1.5">Ball valve · {entity}</div>
        </div>
        <button onClick={() => onClearAll(entity, role)} disabled={busy}
          className="ctl border-[var(--color-danger)] text-[var(--color-danger)] hover:!border-[var(--color-danger)] hover:!bg-[var(--color-danger-solid)] hover:!text-white h-10 px-5 text-[12px]">
          Clear calibration
        </button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-700 bg-card px-4 py-3">
          <div className="text-xs font-bold text-text-muted uppercase tracking-wide">Position</div>
          <div className={`font-mono font-bold tabular-nums leading-tight mt-1 text-3xl ${cal?.noSignal ? 'text-red-400' : 'text-green-400'}`}>{live}</div>
        </div>
        <div className="rounded-xl border border-gray-700 bg-card px-4 py-3" data-testid={`bv-fb:${role}`}
          title="The valve's position feedback loop current (FB), as the board measures it across its 120 ohm sense resistor. 4 mA closed, 20 mA open.">
          <div className="text-xs font-bold text-text-muted uppercase tracking-wide">Feedback current</div>
          <div className="font-mono font-bold tabular-nums leading-tight mt-1 text-xl text-gray-300">
            {cal?.liveCounts != null ? `${loopMilliamps(cal.liveCounts).toFixed(2)} mA` : '—'}
          </div>
        </div>
        <div className="rounded-xl border border-gray-700 bg-card px-4 py-3">
          <div className="text-xs font-bold text-text-muted uppercase tracking-wide">Raw</div>
          <div className="font-mono font-bold tabular-nums leading-tight mt-1 text-xl text-gray-300">{cal?.liveCounts ?? '—'}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * Step 2: record the feedback current at each end of travel. "Drive closed" / "Drive open" run a
 * trial at the saved current (step 1); once the feedback settles, "Record as 0%" / "Record as
 * 100%" store it (the backend averages the last second).
 */
function PositionCalCard({ role, entity, cal, stored, busy, onEndpoint, onAction }: {
  role: string; entity: string; cal?: ValveCal; stored?: StoredCurrents; busy: boolean;
  onEndpoint: (entity: string, action: EndpointAction) => void;
  onAction: (entity: string, body: CurrentAction) => void;
}) {
  const closedMa = stored?.closedMa ?? DEFAULT_CLOSED_MA;
  const openMa = stored?.openMa ?? DEFAULT_OPEN_MA;
  const ep = cal?.endpoints;
  const live = cal?.liveCounts != null ? loopMilliamps(cal.liveCounts) : null;
  const fb = (counts?: number) => (counts !== undefined ? `${loopMilliamps(counts).toFixed(2)} mA` : 'not set');
  const btn = 'ctl h-10 px-4 text-[12px]';
  const noLive = cal?.liveCounts == null || cal?.noSignal;
  const end = (label: string, which: 'closed' | 'open', ma: number, counts: number | undefined) => (
    <div className="rounded-lg border border-gray-800 bg-black/20 p-4 flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold text-text">{label}</span>
        <span className="font-mono text-sm text-text-muted">feedback {fb(counts)}</span>
      </div>
      <div className="flex gap-3 flex-wrap">
        <button className={btn} disabled={busy}
          title={`Drive the valve at its saved ${which} current (${ma.toFixed(2)} mA) so it travels fully ${which}`}
          onClick={() => onAction(entity, { action: 'trial', ma })}>Drive {which} ({ma.toFixed(2)} mA)</button>
        <button className={btn} disabled={busy || noLive}
          title={`Once the feedback has stopped moving: store it as fully ${which} (${which === 'closed' ? '0' : '100'} %)`}
          onClick={() => onEndpoint(entity, which)}>Record as {which === 'closed' ? '0%' : '100%'}</button>
      </div>
    </div>
  );
  return (
    <div className="rounded-xl border border-gray-700 bg-card p-5 flex flex-col gap-3" data-testid={`bv-position:${role}`}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap">
        <span className="text-sm font-bold text-text">Step 2 · Position: record the feedback current at closed and open</span>
        <span className="font-mono text-sm text-text-muted">live feedback {live != null ? `${live.toFixed(2)} mA` : '—'}</span>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        {end('Fully closed (0 %)', 'closed', closedMa, ep?.closedCounts)}
        {end('Fully open (100 %)', 'open', openMa, ep?.openCounts)}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button className={btn} disabled={busy} title="Stop driving the trial current: back to the commanded state's current"
          onClick={() => onAction(entity, { action: 'end_trial' })}>Stop driving</button>
      </div>
    </div>
  );
}

/**
 * Sidebar list: one row per ball valve with its live position. Clicking a row opens that valve's
 * calibration in the page's center pane (BallValveCalPanel with `entity`).
 */
function BallValveListRow({ role, entity, selected, onSelect }: { role: string; entity: string; selected: boolean; onSelect: () => void }) {
  const pct = useSensorValue(entity, 'position_pct');
  return (
    <button onClick={onSelect} data-testid={`bv-row:${role}`}
      className={`w-full text-left pl-4 pr-4 py-3.5 flex items-center gap-3 border-l-[3px] transition-colors
        ${selected ? 'bg-blue-950/40 border-l-blue-500' : 'border-l-transparent hover:bg-white/5'}`}>
      <div className="min-w-0 flex-1">
        <span className={`text-base font-semibold truncate ${selected ? 'text-text' : 'text-gray-200'}`}>{role}</span>
        <div className="text-sm font-mono text-text-muted mt-1">ball valve</div>
      </div>
      <span className="text-xl font-mono font-bold tabular-nums text-green-400 leading-none">
        {pct != null ? `${Math.round(pct)}%` : '---'}
      </span>
    </button>
  );
}

export function BallValveList({ config, selected, onSelect }: {
  config: Record<string, any> | null; selected: string | null; onSelect: (entity: string) => void;
}) {
  const valves = useMemo(() => ballValveRoles(config), [config]);
  const [open, setOpen] = useState(true);
  if (valves.length === 0) return null;
  return (
    <div className="flex-shrink-0 border-t border-gray-800">
      <button onClick={() => setOpen((v) => !v)} className="w-full px-4 py-3 flex items-center justify-between hover:bg-white/5">
        <div className="text-left">
          <div className="text-xs font-bold text-text-muted uppercase tracking-wide">Ball valves</div>
        </div>
        <span className="text-gray-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="divide-y divide-gray-800/40 border-t border-gray-800/60">
          {valves.map((v) => (
            <BallValveListRow key={v.entity} role={v.role} entity={v.entity}
              selected={v.entity === selected} onSelect={() => onSelect(v.entity)} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The center-pane detail. `entity` limits it to the valve picked in BallValveList; without one
 *  it shows every valve. `sessionActive` is accepted for the page's call but unused: nothing here
 *  needs the live stream to act, and config_broadcast, which delivers the currents, runs without a
 *  session. */
export function BallValveCalPanel({ config, entity }: { config: Record<string, any> | null; entity?: string | null; sessionActive?: boolean }) {
  const allValves = useMemo(() => ballValveRoles(config), [config]);
  const valves = useMemo(() => (entity ? allValves.filter((v) => v.entity === entity) : allValves), [allValves, entity]);
  const [cal, setCal] = useState<Record<string, ValveCal>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const onEndpoint = useCallback(async (entity: string, action: EndpointAction) => {
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

  // Clear calibration: the command currents back to 4 / 20 mA and the recorded feedback readings
  // forgotten, so % open is back on the ideal 4-20 mA line.
  const onClearAll = useCallback(async (entity: string, role: string) => {
    if (typeof window !== 'undefined' && !window.confirm(`Clear the calibration for ${role}? Its currents go back to 4 / 20 mA and its recorded feedback readings are dropped.`)) return;
    await onCurrentAction(entity, { action: 'clear' });
    await onEndpoint(entity, 'clear');
  }, [onCurrentAction, onEndpoint]);

  if (valves.length === 0) return null;
  return (
    <div className="p-8 max-w-5xl mx-auto flex flex-col gap-10">
      {error && <p className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-2 text-sm text-red-400" role="alert">{error}</p>}
      {valves.map((v) => (
        <ValveRow key={v.entity} role={v.role} entity={v.entity} cal={cal[v.entity]} busy={busy} onClearAll={onClearAll}>
          <CommandCurrentRow key={v.entity} role={v.role} entity={v.entity} stored={currents[v.entity]}
            trial={trials[v.entity]} limits={limits} onAction={onCurrentAction} busy={busy} nowMs={nowMs} />
          <PositionCalCard role={v.role} entity={v.entity} cal={cal[v.entity]} stored={currents[v.entity]}
            busy={busy} onEndpoint={onEndpoint} onAction={onCurrentAction} />
        </ValveRow>
      ))}
    </div>
  );
}
