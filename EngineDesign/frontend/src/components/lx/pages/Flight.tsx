import { useEffect, useMemo, useState } from 'react';
import type { FlightResult, PassFigures } from '../../../api/layerx';
import { G0, PSI } from '../../layerx/format';
import { alignOnto } from '../charts/resample';
import { Chart } from '../charts/Chart';
import type { ChartLimit, ChartSeries } from '../charts/types';
import { colOf, flightStabilityOf, type FlightStability } from '../contract';
import { formatT } from '../time/markers';
import { followCursor } from '../time/follow';
import { useTimeStore } from '../time/hooks';
import { createTimeStore, type TimeStore } from '../time/store';
import { Figure, NotComputed, Panel } from '../ui';
import { NBSP, useUnits, type Quantity, type Units } from '../units';
import { convert as conv, figureDelta, type GradedLimit } from '../useRunData';
import { ChartPanel, FigureRow, Hint, Table } from './kit';
import type { PageProps } from './Overview';

/**
 * Flight asks "How does it fly?": the delivered burn flown in EngineDesign's flight simulation,
 * with the vehicle's acceleration fed back into every liquid column. Ported from layerx/Flight.tsx:
 * the figures, the same burn on the pad and in flight, the acceleration through the burn (on the
 * burn's clock), the climb to apogee (a clock of its own), and what the vehicle weighed.
 */

const ROWS: { key: keyof PassFigures; label: string; q: (u: Units, v: number | null) => Quantity }[] = [
  { key: 'total_impulse_Ns', label: 'Total impulse', q: (u, v) => u.impulse(v) },
  { key: 'burn_time_s', label: 'Burn time', q: (u, v) => u.time(v) },
  { key: 'mean_thrust_N', label: 'Mean thrust', q: (u, v) => u.f(v) },
  { key: 'pc_mean_psia', label: 'Chamber pressure', q: (u, v) => u.p(v) },
  { key: 'of_mean', label: 'O/F', q: (u, v) => u.of(v) },
  { key: 'isp_mean_s', label: 'Isp', q: (u, v) => u.isp(v) },
  { key: 'ox_manifold_mean_psia', label: 'LOX injector inlet, mean', q: (u, v) => u.p(v) },
  { key: 'fuel_manifold_mean_psia', label: 'Fuel injector inlet, mean', q: (u, v) => u.p(v) },
  { key: 'ox_dp_injector_min_psi', label: 'LOX injector ΔP, lowest', q: (u, v) => u.dp(v) },
  { key: 'fuel_dp_injector_min_psi', label: 'Fuel injector ΔP, lowest', q: (u, v) => u.dp(v) },
];

function PadVsFlight({ pad, flight }: { pad: PassFigures; flight: PassFigures }) {
  const u = useUnits();
  return (
    <Table caption="The same burn on the pad and in flight" head={[{ sr: 'Quantity' }, 'On the pad', 'In flight', 'Change']} align={['l', 'r', 'r', 'r']}
           rows={ROWS.map((r) => {
             const a = r.q(u, pad[r.key] ?? null);
             const b = r.q(u, flight[r.key] ?? null);
             return [r.label, u.fmt(a), u.fmt(b), figureDelta(b, a, 'both') ?? '—'];
           })} />
  );
}

/**
 * Static margin through the flight: the series when the run carries it (flight.stability.t), else
 * the moments the flight reports (liftoff, rail exit, burnout, the lowest and highest).
 */
function StaticMargin({ st, limit, store, events }: { st: FlightStability; limit: GradedLimit | undefined; store: TimeStore; events: { t: number; key: string; label: string; kind: string }[] }) {
  const series = useMemo<ChartSeries[] | null>(() => {
    const t = st.t ?? [];
    const sm = colOf(st.static_margin_cal, t.length);
    return sm ? [{ key: 'static_margin', label: 'Static margin', color: '--lx-text', values: sm }] : null;
  }, [st]);
  const limits = useMemo<ChartLimit[] | undefined>(() => (limit && !limit.info && Number.isFinite(limit.spec.limit)
    ? [{ value: limit.spec.limit, status: 'bad', label: `min ${limit.spec.limit}` }, ...(limit.spec.warn !== undefined ? [{ value: limit.spec.warn, status: 'warn' as const, label: `${limit.spec.warn}` }] : [])]
    : undefined), [limit]);
  const cal = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2));
  const rows: [string, string, string][] = [
    ['Liftoff', cal(st.static_margin_liftoff_cal), ''],
    ['Rail exit', cal(st.static_margin_rail_exit_cal), ''],
    ['Burnout', cal(st.static_margin_burnout_cal), ''],
    ['Lowest', cal(st.min_stability_margin_cal), st.min_stability_margin_time_s !== null && st.min_stability_margin_time_s !== undefined ? `at ${formatT(st.min_stability_margin_time_s)}` : ''],
    ['Highest', cal(st.max_stability_margin_cal), st.max_stability_margin_time_s !== null && st.max_stability_margin_time_s !== undefined ? `at ${formatT(st.max_stability_margin_time_s)}` : ''],
  ].filter((r) => r[1] !== '—') as [string, string, string][];
  return (
    <Panel title={<Hint text="How far the centre of pressure sits behind the centre of gravity, in body diameters (calibers). It moves as the propellant burns and the rocket speeds up.">Static margin</Hint>}
           right={series ? <span>through the burn</span> : undefined} className="lg:col-span-12" bodyClassName="!pt-1">
      {series
        ? <Chart t={st.t ?? []} series={series} yUnit="cal" height={220} store={store} events={events} digits={2} limits={limits} />
        : rows.length
          ? <div className="pt-3"><FigureRow>{rows.map(([k, v, when]) => <Figure key={k} label={k} value={v} unit="cal" sub={when || undefined} />)}</FigureRow></div>
          : <NotComputed height={96} />}
    </Panel>
  );
}

export function Flight({ data, vs }: PageProps) {
  const u = useUnits();
  const flight: FlightResult | null = data.flight;
  const vsFlight = vs?.flight?.ok ? vs.flight : null;
  // The climb runs to apogee, long after the burn: its charts share a cursor of their own, which
  // follows the page's (both clocks start at Fire) and can be scrubbed on past burnout by hand.
  const [climbStore] = useState(() => createTimeStore());
  const pageStore = useTimeStore();
  const ch = useMemo(() => {
    if (!flight?.ok) return null;
    const t0 = flight.schedule.t[0] ?? 0;
    const alt = u.scale('altitude');
    const vel = u.scale('velocity');
    const accelT = flight.schedule.t.map((t) => t - t0);
    const vsAccel = vsFlight ? {
      t: vsFlight.schedule.t.map((t) => t - (vsFlight.schedule.t[0] ?? 0)), v: vsFlight.schedule.accel_m_s2.map((a) => a / G0),
    } : null;
    return {
      accelT,
      accel: [
        ...(vsAccel ? [{ key: 'accel_vs', label: '', color: '', ghost: true, values: alignOnto(accelT, vsAccel.t, vsAccel.v) }] : []),
        { key: 'accel', label: 'On the liquids', color: '--lx-text', values: flight.schedule.accel_m_s2.map((a) => a / G0) },
      ] as ChartSeries[],
      trajT: flight.trajectory.t,
      alt: [
        ...(vsFlight ? [{ key: 'alt_vs', label: '', color: '', ghost: true, values: conv(alignOnto(flight.trajectory.t, vsFlight.trajectory.t, vsFlight.trajectory.altitude_m), alt.to) }] : []),
        { key: 'alt', label: 'Altitude', color: '--lx-text', values: conv(flight.trajectory.altitude_m, alt.to) },
      ] as ChartSeries[],
      vel: [
        ...(vsFlight ? [{ key: 'vel_vs', label: '', color: '', ghost: true, values: conv(alignOnto(flight.trajectory.t, vsFlight.trajectory.t, vsFlight.trajectory.velocity_m_s), vel.to) }] : []),
        { key: 'vel', label: 'Velocity', color: '--lx-text', values: conv(flight.trajectory.velocity_m_s, vel.to) },
      ] as ChartSeries[],
      units: { alt: alt.unit, vel: vel.unit, altDigits: alt.digits, velDigits: vel.digits },
    };
  }, [flight, vsFlight, u]);
  useEffect(() => {
    if (!ch) return undefined;
    climbStore.setSeries(ch.trajT);
    return followCursor(pageStore, climbStore);
  }, [ch, climbStore, pageStore]);
  const climbEvents = useMemo(() => (flight?.ok ? [
    { t: (flight.schedule.t[flight.schedule.t.length - 1] ?? 0) - (flight.schedule.t[0] ?? 0), key: 'burnout', label: 'Burnout', kind: 'burnout' },
    { t: flight.apogee_time_s, key: 'apogee', label: 'Apogee', kind: 'end' },
  ] : []), [flight]);

  if (!flight) return <Panel title="Flight"><NotComputed>Not flown: turn on Flight in the rail</NotComputed></Panel>;
  if (!flight.ok || !ch) return <Panel title="Flight"><NotComputed>{flight.error ? `Not flown: ${flight.error}` : 'The burn was not flown'}</NotComputed></Panel>;

  const rq = vsFlight;
  const q = {
    apogee: u.alt(flight.apogee_agl_m), vmax: u.v(flight.max_velocity_m_s), rail: u.v(flight.rail_exit_velocity_m_s),
  };
  const b = flight.mass_budget;
  const ceiling = flight.ceiling;
  const fst = flightStabilityOf(flight);
  const smLimit = data.limits.find((l) => /static_margin|stability_margin/.test(l.key));
  const maxQ = fst?.max_q_pa ?? null;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      <Panel ariaLabel="Flight figures" className="lg:col-span-12">
        <FigureRow min="7.5rem">
          <Figure label="Apogee" termKey="apogee" size="lg" q={q.apogee} delta={figureDelta(q.apogee, rq ? u.alt(rq.apogee_agl_m) : null, 'pct')}
                  sub={`AGL · ${u.fmt(u.time(flight.apogee_time_s))}`} />
          <Figure label="Max velocity" q={q.vmax} delta={figureDelta(q.vmax, rq ? u.v(rq.max_velocity_m_s) : null)} sub={`Mach ${flight.max_mach.toFixed(2)}`} />
          <Figure label="Rail exit" q={q.rail} sub={`at ${u.fmt(u.time(flight.rail_exit_time_s))}`} />
          <Figure label="Liftoff acceleration" termKey="specificForce" value={flight.liftoff_accel_g.toFixed(2)} unit="g" sub={`${u.fmt(u.m(flight.liftoff_mass_kg))} on the rail`} />
          <Figure label="Peak acceleration" termKey="specificForce" value={flight.max_accel_g.toFixed(2)} unit="g" sub={`at ${u.fmt(u.time(flight.max_accel_time_s))}`} />
          {maxQ !== null && <Figure label="Max-Q" termKey="maxQ" q={u.dp(maxQ / PSI)} sub={fst?.max_q_t !== null && fst?.max_q_t !== undefined ? `at ${formatT(fst.max_q_t)}` : undefined} />}
          {ceiling
            ? <Figure label="Under the ceiling" q={u.alt(ceiling.margin_m)} sub={`${ceiling.passed ? 'under' : 'over'} ${u.fmt(u.alt(ceiling.limit_m))} ${ceiling.datum}`} />
            : <Figure label="Burnout mass" q={u.m(flight.burnout_mass_kg)} sub="residuals carried" />}
        </FigureRow>
      </Panel>

      <ChartPanel title="Acceleration on the liquids" className="lg:col-span-4" t={ch.accelT} series={ch.accel} yUnit="g" height={220} events={data.events} digits={2} />
      <ChartPanel title="Altitude" className="lg:col-span-4" t={ch.trajT} series={ch.alt} yUnit={ch.units.alt} height={220} store={climbStore} events={climbEvents} digits={ch.units.altDigits} />
      <ChartPanel title="Velocity" className="lg:col-span-4" t={ch.trajT} series={ch.vel} yUnit={ch.units.vel} height={220} store={climbStore} events={climbEvents} digits={ch.units.velDigits} />

      {flight.pad && flight.in_flight && (
        <Panel title={<Hint text="The same burn twice: on the pad at one g, and flying, with every liquid column at the flight's acceleration. The longer line gains more head, so the flows and O/F move.">Pad vs flight</Hint>}
               className="lg:col-span-7">
          <PadVsFlight pad={flight.pad} flight={flight.in_flight} />
        </Panel>
      )}

      <Panel title="Vehicle" className={flight.pad && flight.in_flight ? 'lg:col-span-5' : 'lg:col-span-12'}>
        {b ? (
          <Table caption="What the vehicle lifted off at" head={[{ sr: 'Part' }, 'Mass']} align={['l', 'r']}
                 rows={[
                   [<Hint key="a" text={b.airframe_source === 'liftoff mass' ? 'What is left of the liftoff mass you entered once the engine, tanks, propellant and gas are counted.' : "The design's airframe_mass: body, nose, fins, avionics, recovery, payload."}>Airframe</Hint>, u.fmt(u.m(b.airframe_kg))],
                   ['Engine and tanks', u.fmt(u.m(b.motor_dry_kg))],
                   [<span key="l" style={{ color: 'var(--lx-lox)' }}>LOX</span>, u.fmt(u.m(b.oxidizer_kg))],
                   [<span key="f" style={{ color: 'var(--lx-fuel)' }}>Fuel</span>, u.fmt(u.m(b.fuel_kg))],
                   [<span key="g" style={{ color: 'var(--lx-gas)' }}>Gas</span>, u.fmt(u.m(b.pressurant_kg + b.ullage_gas_kg))],
                   [<strong key="t" className="font-medium text-[var(--lx-text)]">Liftoff{b.airframe_source === 'liftoff mass' ? ', as entered' : ', design'}</strong>, u.fmt(u.m(b.liftoff_kg))],
                 ]} />
        ) : <NotComputed height={60} />}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--lx-text-3)]">
          {flight.vehicle_lines.map((l) => (
            <Hint key={l.side} text={`${(l.lines ?? []).join(' → ') || 'no path traced'}: ${(l.length_m ?? NaN).toFixed(2)} m of line on the drawing.${l.used === 'none' ? ' The drawing gives these lines no height, so in flight only the tank’s own liquid feels the acceleration.' : ''}`}>
              <span style={{ color: l.side === 'oxidiser' ? 'var(--lx-lox)' : 'var(--lx-fuel)' }}>{l.side === 'oxidiser' ? 'LOX' : 'Fuel'} line</span>{' '}
              {l.used === 'none' ? <span style={{ color: 'var(--lx-warn)' }}>no height</span> : <span className="lx-num">falls {u.fmt(u.len(l.drop_m))}</span>}
            </Hint>
          ))}
          {flight.notes.length > 0 && <Hint text={flight.notes.join(' ')}>{flight.notes.length}{NBSP}note{flight.notes.length > 1 ? 's' : ''}</Hint>}
        </div>
      </Panel>
      {/* flight.stability.t is the burn's clock (DATA-CONTRACT 4): the page's cursor, not the climb's. */}
      {fst && <StaticMargin st={fst} limit={smLimit} store={pageStore} events={data.events} />}
    </div>
  );
}
