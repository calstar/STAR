/**
 * Calibration page: each ball valve's two-point calibration. Drive the valve fully closed and
 * press "Fully closed"; fully open and press "Fully open". The backend stores the mean of the last
 * second of raw counts for each, and % open becomes a straight line between them
 * (backend/src/ball-valve-cal.ts). "Clear" returns the valve to the ideal 4-20 mA line.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSensorValue } from '@/lib/store';
import { getApiBaseUrl } from '@/lib/websocket';
import { elodinSlotFromBoardId } from '@/lib/sensor-info-entities';

interface Endpoints { closedCounts?: number; openCounts?: number; closedAtMs?: number; openAtMs?: number }
interface ValveCal { entity: string; endpoints: Endpoints | null; liveCounts: number | null; noSignal: boolean }

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

function ValveRow({ role, entity, cal, sessionActive, onAction, busy }: {
  role: string; entity: string; cal?: ValveCal; sessionActive: boolean;
  onAction: (entity: string, action: 'closed' | 'open' | 'clear') => void; busy: boolean;
}) {
  const pct = useSensorValue(entity, 'position_pct');
  const ep = cal?.endpoints;
  const calibrated = ep?.closedCounts !== undefined || ep?.openCounts !== undefined;
  const live = cal?.noSignal ? 'NO SIGNAL' : pct != null ? `${Math.round(pct)}% open` : '--- %';
  const disabled = !sessionActive || busy;
  const why = sessionActive ? undefined : 'Start a session to calibrate: with no live stream there is nothing to capture.';
  return (
    <div className="px-4 py-3 flex flex-col gap-2" data-testid={`bv-cal:${role}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-text truncate">{role}</span>
        <span className="font-mono text-sm tabular-nums text-text">{live}</span>
      </div>
      <div className="font-mono text-[11px] text-text-muted flex gap-3 flex-wrap">
        <span>raw {cal?.liveCounts ?? '—'}</span>
        <span>closed {ep?.closedCounts ?? 'ideal'}</span>
        <span>open {ep?.openCounts ?? 'ideal'}</span>
      </div>
      <div className="flex gap-2">
        <button className="ctl h-8 flex-1 px-2 text-[11px]" disabled={disabled} title={why ?? 'Valve is fully closed now: store this reading as 0 % open'}
          onClick={() => onAction(entity, 'closed')}>Fully closed</button>
        <button className="ctl h-8 flex-1 px-2 text-[11px]" disabled={disabled} title={why ?? 'Valve is fully open now: store this reading as 100 % open'}
          onClick={() => onAction(entity, 'open')}>Fully open</button>
        <button className="ctl h-8 px-2 text-[11px]" disabled={busy || !calibrated} title="Back to the ideal 4-20 mA line"
          onClick={() => onAction(entity, 'clear')}>Clear</button>
      </div>
    </div>
  );
}

export function BallValveCalPanel({ config, sessionActive }: { config: Record<string, any> | null; sessionActive: boolean }) {
  const valves = useMemo(() => ballValveRoles(config), [config]);
  const [cal, setCal] = useState<Record<string, ValveCal>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(true);

  const adopt = (list: ValveCal[] | undefined) =>
    setCal(Object.fromEntries((list ?? []).map((v) => [v.entity, v])));

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

  const onAction = useCallback(async (entity: string, action: 'closed' | 'open' | 'clear') => {
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
          <div className="text-sm text-text-muted mt-1">Two-point: fully closed, fully open</div>
        </div>
        <span className="text-gray-600">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="divide-y divide-gray-800/40 border-t border-gray-800/60">
          {error && <p className="px-4 py-2 text-[12px] text-red-400" role="alert">{error}</p>}
          {valves.map((v) => (
            <ValveRow key={v.entity} role={v.role} entity={v.entity} cal={cal[v.entity]}
              sessionActive={sessionActive} onAction={onAction} busy={busy} />
          ))}
        </div>
      )}
    </div>
  );
}
