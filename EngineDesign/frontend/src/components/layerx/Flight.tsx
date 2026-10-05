import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { FlightResult, MassBudget, PassFigures } from '../../api/layerx';
import { Hint } from '../Hint';
import { fmt, FT, G0, LB, LOX, FUEL } from './format';

/**
 * Phase 6 (engine/layerx/flight.py): the delivered burn flown in EngineDesign's flight simulation,
 * with the vehicle's acceleration fed back into every liquid column until it stopped moving.
 *
 *   figures   apogee, speed, Mach, rail exit, the acceleration the liquids felt
 *   effect    the same burn on the pad (one g) and in flight, side by side
 *   plots     the acceleration through the burn, and the trajectory to apogee
 */

const axisTick = { fill: 'var(--color-text-muted)', fontSize: 10 };
const tooltipStyle = { background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 11 };

function Figure({ label, value, unit, sub, hint }: { label: string; value: string; unit: string; sub?: string; hint: string }) {
  return (
    <div className="min-w-0">
      <Hint text={hint}><span className="text-xs text-[var(--color-text-secondary)]">{label}</span></Hint>
      <div className="mt-1 flex items-baseline gap-1 whitespace-nowrap">
        <span className="text-[1.6rem] leading-none font-semibold tracking-tight text-[var(--color-text-primary)] tabular-nums">{value}</span>
        <span className="text-[12px] text-[var(--color-text-muted)]">{unit}</span>
      </div>
      {sub && <div className="mt-1.5 text-[11px] text-[var(--color-text-muted)] tabular-nums">{sub}</div>}
    </div>
  );
}

const ROWS: { key: keyof PassFigures; label: string; unit: string; digits: number; hint?: string; scale?: number }[] = [
  { key: 'total_impulse_Ns', label: 'Total impulse', unit: 'kN·s', digits: 2, scale: 1e-3 },
  { key: 'burn_time_s', label: 'Burn time', unit: 's', digits: 2 },
  { key: 'mean_thrust_N', label: 'Mean thrust', unit: 'N', digits: 0 },
  { key: 'pc_mean_psia', label: 'Chamber pressure', unit: 'psia', digits: 1 },
  { key: 'of_mean', label: 'O/F', unit: '', digits: 3, hint: 'LOX burned over fuel burned.' },
  { key: 'isp_mean_s', label: 'Isp', unit: 's', digits: 1 },
  { key: 'ox_manifold_mean_psia', label: 'LOX injector inlet, mean', unit: 'psia', digits: 1 },
  { key: 'fuel_manifold_mean_psia', label: 'Fuel injector inlet, mean', unit: 'psia', digits: 1 },
  { key: 'ox_dp_injector_min_psi', label: 'LOX injector ΔP, lowest', unit: 'psi', digits: 1 },
  { key: 'fuel_dp_injector_min_psi', label: 'Fuel injector ΔP, lowest', unit: 'psi', digits: 1 },
];

function Effect({ pad, flight }: { pad: PassFigures; flight: PassFigures }) {
  return (
    <table className="w-full max-w-2xl text-[12px] tabular-nums">
      <thead>
        <tr className="text-left text-[var(--color-text-muted)]">
          <th className="py-1 font-normal" />
          <th className="py-1 font-normal text-right" title="The same vehicle sitting on the pad at one g, with its feed-line heights.">On the pad</th>
          <th className="py-1 font-normal text-right">In flight</th>
          <th className="py-1 font-normal text-right">Change</th>
        </tr>
      </thead>
      <tbody>
        {ROWS.map((r) => {
          const k = r.scale ?? 1;
          const a = pad[r.key] === null || pad[r.key] === undefined ? null : (pad[r.key] as number) * k;
          const b = flight[r.key] === null || flight[r.key] === undefined ? null : (flight[r.key] as number) * k;
          const raw = a !== null && b !== null ? b - a : null;
          // A difference that rounds to nothing reads 0, not −0.
          const d = raw !== null && Math.abs(raw) < 0.5 * 10 ** -r.digits ? 0 : raw;
          const rel = d !== null && a ? (d / Math.abs(a)) * 100 : null;
          return (
            <tr key={r.key} className="border-t border-[var(--color-border)]/50">
              <td className="py-1 text-[var(--color-text-secondary)]">{r.hint ? <Hint text={r.hint}>{r.label}</Hint> : r.label}</td>
              <td className="py-1 text-right text-[var(--color-text-secondary)]">{fmt(a, r.digits)} <span className="text-[var(--color-text-muted)]">{r.unit}</span></td>
              <td className="py-1 text-right text-[var(--color-text-primary)]">{fmt(b, r.digits)} <span className="text-[var(--color-text-muted)]">{r.unit}</span></td>
              <td className="py-1 text-right text-[var(--color-text-secondary)]">
                {d === null ? '—' : `${d >= 0 ? '+' : ''}${fmt(d, r.digits)}`}
                {rel !== null && Math.abs(rel) >= 0.05 && <span className="text-[var(--color-text-muted)]"> ({rel >= 0 ? '+' : ''}{fmt(rel, 1)} %)</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Plot({ title, unit, data, x, y, digits, xUnit = 's', stroke = 'var(--color-text-primary)', mark }: {
  title: string; unit: string; data: Record<string, number>[]; x: string; y: string; digits: number; xUnit?: string; stroke?: string; mark?: number;
}) {
  return (
    <div>
      <div className="text-xs text-[var(--color-text-secondary)] mb-1">{title}<span className="text-[var(--color-text-muted)]"> {unit}</span></div>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis dataKey={x} type="number" domain={['dataMin', 'dataMax']} tickCount={5} axisLine={false} tickLine={false}
                 tick={axisTick} tickFormatter={(v: number) => `${fmt(v, 1)} ${xUnit}`} height={18} />
          <YAxis domain={['auto', 'auto']} width={46} tick={axisTick} tickFormatter={(v: number) => fmt(v, digits)} axisLine={false} tickLine={false} tickCount={4} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(t: number) => `t = ${fmt(t, 2)} s`} formatter={(v: number) => [`${fmt(v, digits + 1)} ${unit}`, title]} />
          {mark !== undefined && <ReferenceLine x={mark} stroke="var(--color-border)" strokeDasharray="3 3" />}
          <Line type="monotone" dataKey={y} dot={false} strokeWidth={1.6} stroke={stroke} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function FlightSummary({ flight }: { flight: FlightResult }) {
  if (!flight.ok) return <span style={{ color: 'var(--color-warning)' }}>not flown{flight.error ? `: ${flight.error}` : ''}</span>;
  const d = flight.pad && flight.in_flight && flight.pad.total_impulse_Ns && flight.in_flight.total_impulse_Ns
    ? (flight.in_flight.total_impulse_Ns / flight.pad.total_impulse_Ns - 1) * 100 : null;
  return (
    <>apogee {fmt(flight.apogee_agl_m * FT, 0)} ft AGL · {fmt(flight.liftoff_accel_g, 1)}–{fmt(flight.max_accel_g, 1)} g on the liquids
      {d !== null && <> · impulse {d >= 0 ? '+' : ''}{fmt(d, 1)} % against the pad</>}</>
  );
}

/** The vehicle at liftoff, part by part: what the flight carried and where each number came from. */
function MassLine({ b }: { b: MassBudget }) {
  const gas = b.pressurant_kg + b.ullage_gas_kg;
  const parts: { label: string; kg: number; color?: string; hint: string }[] = [
    { label: 'airframe', kg: b.airframe_kg, hint: b.airframe_source === 'liftoff mass'
      ? 'What is left of the liftoff mass you entered once the engine, tanks, propellant and gas are counted.'
      : "The design's airframe_mass: body, nose, fins, avionics, recovery, payload." },
    { label: 'engine & tanks', kg: b.motor_dry_kg, hint: "The design's engine (with plumbing), tank structures and COPV, empty." },
    { label: 'LOX', kg: b.oxidizer_kg, color: LOX, hint: 'The oxidiser load this burn ran.' },
    { label: 'fuel', kg: b.fuel_kg, color: FUEL, hint: 'The fuel load this burn ran.' },
    { label: 'gas', kg: gas, hint: `Pressurant in the bottle at T-0 (${fmt(b.pressurant_kg, 3)} kg, from the feed twin) and the ullage gas already in the tanks (${fmt(b.ullage_gas_kg, 3)} kg).` },
  ];
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] tabular-nums text-[var(--color-text-secondary)]">
      <span className="text-[var(--color-text-primary)]">
        Liftoff {fmt(b.liftoff_kg / LB, 1)} lb <span className="text-[var(--color-text-muted)]">({fmt(b.liftoff_kg, 2)} kg{b.airframe_source === 'liftoff mass' ? ', as entered' : ', design'})</span>
      </span>
      {parts.map((p) => (
        <Hint key={p.label} text={p.hint}>
          <span><span style={p.color ? { color: p.color } : undefined}>{p.label}</span> {fmt(p.kg, p.kg < 1 ? 2 : 1)}</span>
        </Hint>
      ))}
      <span className="text-[var(--color-text-muted)]">kg</span>
    </div>
  );
}

export function FlightView({ flight }: { flight: FlightResult }) {
  if (!flight.ok) return <div className="text-[13px] text-[var(--color-text-muted)]">{flight.error ?? 'The burn was not flown.'}</div>;
  const t0 = flight.schedule.t[0] ?? 0;
  const burnAccel = flight.schedule.t.map((t, k) => ({ t: t - t0, g: flight.schedule.accel_m_s2[k] / G0 }));
  const traj = flight.trajectory.t.map((t, k) => ({
    t, alt: flight.trajectory.altitude_m[k] * FT, v: flight.trajectory.velocity_m_s[k] * FT, mach: flight.trajectory.mach[k],
  }));
  const burnEnd = burnAccel.length ? burnAccel[burnAccel.length - 1].t : undefined;
  const ceiling = flight.ceiling;
  return (
    <div className="space-y-7">
      <div className="grid gap-x-6 gap-y-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(8.5rem, 1fr))' }}>
        <Figure label="Apogee" value={fmt(flight.apogee_agl_m * FT, 0)} unit="ft"
                sub={`AGL · ${fmt(flight.apogee_agl_m, 0)} m · ${fmt(flight.apogee_time_s, 1)} s`}
                hint="Vertical, windless, from EngineDesign's flight simulation of the delivered thrust and flows, the thrust corrected for altitude from the site's ambient." />
        <Figure label="Max velocity" value={fmt(flight.max_velocity_m_s * FT, 0)} unit="ft/s" sub={`${fmt(flight.max_velocity_m_s, 0)} m/s · Mach ${fmt(flight.max_mach, 2)}`}
                hint="Vertical velocity, and the highest Mach number reached." />
        <Figure label="Rail exit" value={fmt(flight.rail_exit_velocity_m_s * FT, 0)} unit="ft/s" sub={`${fmt(flight.rail_exit_velocity_m_s, 1)} m/s at ${fmt(flight.rail_exit_time_s, 2)} s`}
                hint="Velocity leaving the rail." />
        <Figure label="Liftoff acceleration" value={fmt(flight.liftoff_accel_g, 2)} unit="g" sub={`${fmt(flight.liftoff_mass_kg / LB, 0)} lb · ${fmt(flight.liftoff_mass_kg, 1)} kg on the rail`}
                hint="Proper acceleration along the axis at the first firing step: what an accelerometer reads, and what the liquid columns feel." />
        <Figure label="Peak acceleration" value={fmt(flight.max_accel_g, 2)} unit="g" sub={`at ${fmt(flight.max_accel_time_s, 2)} s`}
                hint="The highest proper acceleration during the burn, as the vehicle lightens." />
        {ceiling ? (
          <Figure label="Apogee ceiling" value={fmt(ceiling.margin_m * FT, 0)} unit="ft spare"
                  sub={`${ceiling.passed ? 'under' : 'OVER'} the ${fmt(ceiling.limit_m * FT, 0)} ft ${ceiling.datum} limit`}
                  hint="design_requirements.max_apogee_m against this apogee." />
        ) : (
          <Figure label="Burnout mass" value={fmt(flight.burnout_mass_kg / LB, 0)} unit="lb" sub={`${fmt(flight.burnout_mass_kg, 1)} kg, residuals carried`}
                  hint="Vehicle mass at the last firing step; propellant the burn left in the tanks flies as dead mass." />
        )}
      </div>

      {flight.pad && flight.in_flight && (
        <div>
          <div className="mb-2">
            <Hint text="The same burn twice: on the pad at one g, and flying, with every liquid column at the flight's acceleration. The longer line gains more head, so the flows and O/F move.">
              <span className="text-sm font-medium text-[var(--color-text-primary)]">Pad vs flight</span>
            </Hint>
          </div>
          <Effect pad={flight.pad} flight={flight.in_flight} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-x-5 gap-y-6">
        <Plot title="Acceleration on the liquids" unit="g" data={burnAccel} x="t" y="g" digits={1} />
        <Plot title="Altitude" unit="ft AGL" data={traj} x="t" y="alt" digits={0} mark={burnEnd} />
        <Plot title="Velocity" unit="ft/s" data={traj} x="t" y="v" digits={0} mark={burnEnd} />
      </div>

      {flight.mass_budget && <MassLine b={flight.mass_budget} />}

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-[var(--color-text-muted)]">
        {flight.vehicle_lines.map((l) => (
          <Hint key={l.side} text={`${(l.lines ?? []).join(' → ') || 'no path traced'}: ${fmt(l.length_m ?? null, 2)} m of line on the drawing. `
            + (l.used === 'none' ? 'The drawing gives these lines no height, so in flight only the tank\'s own liquid feels the acceleration.'
              : `Falls ${fmt((l.drop_m ?? NaN) * FT, 2)} ft (${fmt(l.drop_m ?? null, 2)} m) ${l.used === 'restated' ? 'as you restated it' : 'as drawn'}.`)}>
            <span>
              <span style={{ color: l.side === 'oxidiser' ? LOX : FUEL }}>{l.side === 'oxidiser' ? 'LOX' : 'Fuel'} line</span>{' '}
              {l.used === 'none' ? <span style={{ color: 'var(--color-warning)' }}>no height on the drawing</span> : `falls ${fmt((l.drop_m ?? NaN) * FT, 2)} ft`}
            </span>
          </Hint>
        ))}
        <Hint text="The feed system is the drawing's: its lines, bores, fittings and heights. The vehicle's inertia and drag are the config's; its mass is the design's or the liftoff mass you entered. Lateral acceleration and slosh are not modelled.">
          <span>axial only, no slosh</span>
        </Hint>
      </div>
      {flight.notes.length > 0 && (
        <div className="max-w-3xl space-y-1 text-[12px] text-[var(--color-text-muted)]">
          {flight.notes.map((n, k) => <p key={k}>{n}</p>)}
        </div>
      )}
    </div>
  );
}
