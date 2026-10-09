import { useEffect, useMemo, useState } from 'react';
import { Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { layerx, type DaqChannel, type LayerXResult } from '../../api/layerx';
import { Hint } from '../Hint';
import { filled, findFire, matchColumn, parseDaqCsv, residual, type DaqData } from './daqcsv';
import { fmt, PSI, tickDigits } from './format';

/**
 * The prediction against the stand: each instrument on the drawing paired with the DAQ channel
 * that records it (kept on the server with the drawing), what it should read at T-0, one second in
 * and at burnout, and, once a DAQ export is loaded, what it did read, with the bias and scatter
 * between them. Pressures as the transducers read them (gauge); temperatures in K.
 *
 * Thrust is the load cells' sum against the burn's thrust.
 */

const THRUST = '__thrust__';
const axisTick = { fill: 'var(--color-text-muted)', fontSize: 10 };

type Row = { id: string; tag: string; unit: 'psig' | 'K' | 'N'; values: number[] };

export function MeasuredView({ result }: { result: LayerXResult }) {
  const drawingId = result.provenance.drawing.id;
  const s = result.series;
  const gauge = ((result.provenance.derived?.gauge_zero_pa as number | undefined) ?? 101325) / PSI;
  const [daq, setDaq] = useState<DaqChannel[] | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [data, setData] = useState<DaqData | null>(null);
  const [file, setFile] = useState('');
  const [fire, setFire] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lcUnit, setLcUnit] = useState<'N' | 'lbf'>('N');

  useEffect(() => {
    layerx.daqChannels().then((r) => setDaq(r.data?.channels ?? []));
    layerx.channels(drawingId).then((r) => setMap(r.data?.channels ?? {}));
  }, [drawingId]);

  // Predicted columns on the burn's own clock (Fire = 0): the drawing's instruments, and thrust.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = Object.entries(s.instruments ?? {}).map(([id, ins]) => ({
      id, tag: ins.tag, unit: ins.unit === 'K' ? 'K' : 'psig',
      values: ins.unit === 'K' ? ins.values : ins.values.map((v) => v - gauge),
    }));
    const dv = result.delivered;
    const thrust = s.t.map((_, i) => (s.firing[i] ? s.chamber.thrust_N[i] : 0));
    if (dv?.thrust_N) {
      let k = 0;
      s.firing.forEach((f, i) => { if (f) thrust[i] = dv.thrust_N[k++] ?? thrust[i]; });
    }
    out.push({ id: THRUST, tag: 'Thrust', unit: 'N', values: thrust });
    return out;
  }, [s, result.delivered, gauge]);

  const at = (r: Row, t: number) => {
    let k = 0;
    while (k < s.t.length - 1 && s.t[k + 1] <= t + 1e-9) k++;
    return r.values[k];
  };
  const end = s.t[s.t.length - 1] ?? 0;
  const fireIndex = s.firing.findIndex(Boolean);

  const measured = (r: Row): (number | null)[] | null => {
    if (!data) return null;
    if (r.id === THRUST) {
      const lcs = Object.keys(data.columns).filter((n) => /(^|[^a-z])lc_/i.test(n));
      if (!lcs.length) return null;
      const scale = lcUnit === 'lbf' ? 4.4482216 : 1;
      const cols = lcs.map((n) => filled(data.columns[n]));
      return data.t.map((_, i) => (cols.every((c) => c[i] !== null) ? cols.reduce((a, c) => a + (c[i] as number), 0) * scale : null));
    }
    const ch = map[r.id];
    const col = ch ? matchColumn(data, ch) : null;
    return col ? data.columns[col] : null;
  };

  // Fire in the file: from the mapped instrument that jumps most at Fire (a downstream transducer).
  const autoFire = useMemo(() => {
    if (!data || fireIndex < 1) return null;
    let best: { r: Row; jump: number } | null = null;
    for (const r of rows) {
      if (r.id === THRUST || !map[r.id]) continue;
      const before = r.values[fireIndex - 1];
      const after = at(r, 0.3);
      if (best === null || Math.abs(after - before) > best.jump) best = { r, jump: Math.abs(after - before) };
    }
    if (!best || best.jump < 20) return null;
    const m = measured(best.r);
    return m ? findFire(data.t, m, best.r.values[fireIndex - 1], at(best.r, 0.3)) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rows, map, fireIndex]);
  const fireAt = fire ?? autoFire;

  const save = (id: string, channel: string) => {
    const next = { ...map, [id]: channel };
    if (!channel) delete next[id];
    setMap(next);
    layerx.putChannels(drawingId, next).then((r) => { if (r.error) setError(r.error); });
  };
  const load = async (f: File) => {
    setError(null);
    try {
      const parsed = parseDaqCsv(await f.text());
      setData(parsed);
      setFile(f.name);
      setFire(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!s.instruments) return <div className="text-[13px] text-[var(--color-text-muted)]">This burn predates instrument readings: run it again.</div>;
  const cell = 'rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[12px] text-[var(--color-text-primary)]';
  const kindOf = (r: Row) => (r.unit === 'K' ? ['TC', 'RTD'] : ['PT']);
  const digits = (r: Row) => (r.unit === 'N' ? 0 : r.unit === 'K' ? 1 : 1);

  return (
    <div className="space-y-5">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-[var(--color-text-muted)]">
              <th className="py-1 font-normal">On the drawing</th>
              <th className="py-1 font-normal">DAQ channel</th>
              <th className="py-1 font-normal text-right">T−0</th>
              <th className="py-1 font-normal text-right">T+1 s</th>
              <th className="py-1 font-normal text-right">Burnout</th>
              {data && fireAt !== null && <th className="py-1 font-normal text-right">Measured − predicted</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = measured(r);
              const res = m && data && fireAt !== null
                ? residual(s.t, r.values, data.t.map((t) => t - fireAt), m, 0.2, end) : null;
              const options = (daq ?? []).filter((c) => kindOf(r).includes(c.kind));
              return (
                <tr key={r.id} className="border-t border-[var(--color-border)]/50">
                  <td className="py-1 text-[var(--color-text-secondary)]">{r.tag} <span className="text-[var(--color-text-muted)]">{r.unit}</span></td>
                  <td className="py-1">
                    {r.id === THRUST ? (
                      <span className="text-[var(--color-text-muted)]">sum of the LC_ channels in{' '}
                        <select className={cell} value={lcUnit} aria-label="Load cell unit" onChange={(e) => setLcUnit(e.target.value as 'N' | 'lbf')}>
                          <option value="N">N</option><option value="lbf">lbf</option>
                        </select>
                      </span>
                    ) : (
                      <select className={cell} value={map[r.id] ?? ''} aria-label={`DAQ channel for ${r.tag}`} onChange={(e) => save(r.id, e.target.value)}>
                        <option value="">not recorded</option>
                        {options.map((c) => <option key={c.name} value={c.name}>{c.name}{c.purpose ? ` · ${c.purpose}` : ''}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="py-1 text-right">{fmt(fireIndex > 0 ? r.values[fireIndex - 1] : r.values[0], digits(r))}</td>
                  <td className="py-1 text-right">{fmt(at(r, 1.0), digits(r))}</td>
                  <td className="py-1 text-right">{fmt(r.values[r.values.length - 1], digits(r))}</td>
                  {data && fireAt !== null && (
                    <td className="py-1 text-right">
                      {res ? <>{res.mean >= 0 ? '+' : '−'}{fmt(Math.abs(res.mean), digits(r))} <span className="text-[var(--color-text-muted)]">± {fmt(res.rms, digits(r))}</span></>
                        : <span className="text-[var(--color-text-muted)]">{m ? 'no overlap' : 'not in the file'}</span>}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {daq && daq.length === 0 && <div className="text-[12px] text-[var(--color-warning)]">The DAQ's channel list was not found (daq-server/config/config_ground_daq.toml).</div>}

      <div className="flex flex-wrap items-center gap-3 text-[12px]">
        <label className="cursor-pointer rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]">
          {data ? 'Load another DAQ export' : 'Load a DAQ export (CSV)'}
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ''; }} />
        </label>
        <Hint text="The DAQ web viewer's wide or long CSV export. Pressures are read as gauge, as the transducers report. Fire is found where the mapped transducer that jumps at Fire crosses halfway; type a time to override it.">
          <span className="text-[var(--color-text-muted)]">{data ? `${file}: ${data.t.length} rows, ${Object.keys(data.columns).length} channels` : 'measured against predicted, channel by channel'}</span>
        </Hint>
        {data && (
          <label className="flex items-center gap-2 text-[var(--color-text-secondary)]">
            Fire at
            <input className={`${cell} w-28`} inputMode="decimal" aria-label="Fire time in the file"
                   placeholder={autoFire !== null ? fmt(autoFire, 3) : 'not found'}
                   value={fire ?? ''} onChange={(e) => { const v = Number(e.target.value); setFire(e.target.value.trim() === '' || !Number.isFinite(v) ? null : v); }} />
            <span className="text-[var(--color-text-muted)]">s in the file{fire === null && autoFire !== null ? ' (found)' : ''}</span>
          </label>
        )}
        {error && <span className="text-[var(--color-danger)]">{error}</span>}
      </div>

      {data && fireAt !== null && (
        <div className="grid grid-cols-1 gap-x-5 gap-y-5 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => {
            const m = measured(r);
            if (!m) return null;
            const pred = s.t.map((t, i) => ({ t, v: r.values[i] }));
            const meas = data.t.map((t, i) => ({ t: t - fireAt, v: m[i] })).filter((p) => p.t >= s.t[0] && p.t <= end + 0.5 && p.v !== null);
            const all = [...pred.map((p) => p.v), ...meas.map((p) => p.v as number)].filter(Number.isFinite);
            const lo = Math.min(...all);
            const hi = Math.max(...all);
            return (
              <div key={r.id} className="min-w-0">
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="text-[var(--color-text-secondary)]">{r.tag}{r.id !== THRUST && map[r.id] ? <span className="text-[var(--color-text-muted)]"> · {map[r.id]}</span> : null}</span>
                  <span className="flex items-center gap-2 text-[11px] text-[var(--color-text-muted)]">
                    <svg width="14" height="6" aria-hidden><line x1="0" y1="3" x2="14" y2="3" stroke="var(--color-accent)" strokeWidth="1.6" /></svg>predicted
                    <svg width="14" height="6" aria-hidden><line x1="0" y1="3" x2="14" y2="3" stroke="var(--color-text-primary)" strokeWidth="1.1" strokeDasharray="3 2" /></svg>measured
                  </span>
                </div>
                <ResponsiveContainer width="100%" height={130}>
                  <LineChart margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    <XAxis dataKey="t" type="number" domain={[s.t[0], end + 0.5]} allowDuplicatedCategory={false} tickCount={4} axisLine={false}
                           tickLine={false} tick={axisTick} tickFormatter={(v: number) => `${fmt(v, 1)} s`} height={18} />
                    <YAxis domain={[lo - 0.05 * (hi - lo || 1), hi + 0.05 * (hi - lo || 1)]} width={46} tick={axisTick} axisLine={false} tickLine={false}
                           tickCount={3} tickFormatter={(v: number) => fmt(v, tickDigits(lo, hi, 3))} />
                    <Line data={pred} dataKey="v" dot={false} stroke="var(--color-accent)" strokeWidth={1.6} isAnimationActive={false} />
                    <Line data={meas} dataKey="v" dot={false} stroke="var(--color-text-primary)" strokeWidth={1.1} strokeDasharray="3 2" isAnimationActive={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
