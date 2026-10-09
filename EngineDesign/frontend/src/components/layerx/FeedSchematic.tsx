import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Series } from '../../api/layerx';
import { plume, boundary, type NozzleState, type Plume } from './plume';
import { fmt, FUEL, G0, LOX } from './format';

/**
 * The burn as hardware: bottle, regulator, tanks, lines, injector, chamber and plume, with the
 * pressure at every element, the tanks draining, flow moving in the lines and the plume scaled
 * with thrust. One cursor drives this and every chart beside it; Play runs the burn in time.
 */

const REG = '#c4b5fd';
const INK = 'var(--color-text-primary)';
const MUTED = 'var(--color-text-muted)';
const LINE = 'var(--color-border)';

export interface SchematicProps {
  series: Series;
  cursor: number;
  setCursor: (i: number) => void;
  /** Thrust at a series index [N]: the delivered (replayed) value when there is one. */
  thrustAt?: (i: number) => number | undefined;
  /** Proper acceleration at a burn time [m/s²], when the burn was flown. */
  accelAt?: (t: number) => number | undefined;
  /** No data yet: draw the hardware only. */
  empty?: boolean;
  /** The run's gauge zero [psia]: the bottle is shown as its gauge reads. */
  gaugeZeroPsia?: number;
  /** The nozzle's state at a series index (from the replay): the plume is drawn from it. */
  nozzleAt?: (i: number) => NozzleState | undefined;
}

/** Exit radius in the drawing [px]; the plume is drawn to the same scale. */
const RE_PX = 38;
const EXIT_X = 880;
const AXIS_Y = 174;
const PLUME_END = 1170;
const REGIME_COLOR: Record<string, string> = {
  // Read as words: the propellant hues mean LOX and fuel everywhere else, so not here.
  'under-expanded': 'var(--color-text-secondary)', 'over-expanded': 'var(--color-text-secondary)', ideal: 'var(--color-text-secondary)', separated: 'var(--color-danger)',
};

/** The plume as physics draws it: boundary, shock diamonds, core heat (plume.ts). */
function PlumeShape({ p, strength, heat }: { p: Plume; strength: number; heat: number }) {
  const de = 2 * RE_PX;
  const xmax = (PLUME_END - EXIT_X) / de;
  const steps = 48;
  const upper: string[] = [];
  const lower: string[] = [];
  for (let k = 0; k <= steps; k++) {
    const x = (xmax * k) / steps;
    const r = boundary(p, x) * RE_PX;
    upper.push(`${(EXIT_X + x * de).toFixed(1)} ${(AXIS_Y - r).toFixed(1)}`);
    lower.unshift(`${(EXIT_X + x * de).toFixed(1)} ${(AXIS_Y + r).toFixed(1)}`);
  }
  const d = `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`;
  // Shock strength: how far the exit is from the ambient, on a log scale; faint near ideal.
  const shock = Math.min(0.9, Math.max(0.12, 3.5 * Math.abs(Math.log(p.ratio))));
  const diamonds: number[] = [];
  for (let k = 0; ; k++) {
    const x = (k + 0.5) * p.cellOverDe;
    if (x > xmax - 0.2) break;
    diamonds.push(x);
  }
  return (
    <g opacity={strength}>
      <path d={d} fill="url(#lx-plume)" />
      {diamonds.map((x, k) => {
        const cx = EXIT_X + x * de;
        const w = 0.22 * p.cellOverDe * de;
        const h = 0.55 * Math.max(boundary(p, x), 0.3) * RE_PX;
        return <path key={k} d={`M ${cx - w} ${AXIS_Y} L ${cx} ${AXIS_Y - h} L ${cx + w} ${AXIS_Y} L ${cx} ${AXIS_Y + h} Z`}
                     fill="#fff7d6" opacity={shock * heat * Math.exp(-k * 0.5)} />;
      })}
    </g>
  );
}

const MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** The person's reduced-motion preference. One subscription: `matchMedia` returns a new object
 * each call, and as an effect dependency it resubscribed on every frame of playback. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = typeof window !== 'undefined' ? window.matchMedia?.(MOTION_QUERY) : undefined;
      query?.addEventListener?.('change', notify);
      return () => query?.removeEventListener?.('change', notify);
    },
    () => (typeof window !== 'undefined' ? !!window.matchMedia?.(MOTION_QUERY).matches : false),
    () => false,
  );
}

/** A line carrying flow: a still line under a moving dash whose speed follows the flow. */
function Flow({ d, color, rate, still }: { d: string; color: string; rate: number; still: boolean }) {
  const moving = !still && rate > 0.01;
  return (
    <g>
      <path d={d} fill="none" stroke={color} strokeOpacity={0.28} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      {moving && (
        <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeDasharray="4 10"
              style={{ animation: `lxflow ${Math.max(0.18, 0.9 / rate).toFixed(2)}s linear infinite` }} />
      )}
    </g>
  );
}

function Label({ x, y, children, anchor = 'middle', color = INK, size = 12, weight = 400 }: {
  x: number; y: number; children: React.ReactNode; anchor?: 'start' | 'middle' | 'end'; color?: string; size?: number; weight?: number;
}) {
  return <text x={x} y={y} textAnchor={anchor} fontSize={size} fontWeight={weight} fill={color} style={{ fontVariantNumeric: 'tabular-nums' }}>{children}</text>;
}

function Tank({ x, y, w, h, level, color, name, psia, kg, accel }: {
  x: number; y: number; w: number; h: number; level: number; color: string; name: string; psia?: number; kg?: number; accel?: number;
}) {
  const lv = Math.max(0, Math.min(1, level));
  const id = `clip-${name}`;
  return (
    <g>
      <defs><clipPath id={id}><rect x={x} y={y} width={w} height={h} rx={14} /></clipPath></defs>
      <rect x={x} y={y} width={w} height={h} rx={14} fill="var(--color-bg-primary)" stroke={LINE} strokeWidth={1.5} />
      <rect x={x} y={y + h * (1 - lv)} width={w} height={h * lv} fill={color} fillOpacity={0.32} clipPath={`url(#${id})`}
            style={{ transition: 'y 120ms linear, height 120ms linear' }} />
      <Label x={x + w / 2} y={y + 20} color={color} weight={600}>{name}</Label>
      <Label x={x + w / 2} y={y + 38} size={13} weight={600}>{psia === undefined ? '—' : fmt(psia, 0)}</Label>
      <Label x={x + w / 2} y={y + 52} size={10} color={MUTED}>psia</Label>
      <Label x={x + w / 2} y={y + h - 10} size={11} color={MUTED}>{kg === undefined ? '' : `${fmt(kg, 2)} kg`}</Label>
      {accel !== undefined && accel > 0 && (
        <g transform={`translate(${x - 18}, ${y + h / 2 - 16})`}>
          <path d="M0 0 L0 26 M-5 20 L0 28 L5 20" stroke={MUTED} strokeWidth={1.5} fill="none" />
          <Label x={-6} y={-6} size={10} color={MUTED} anchor="middle">{fmt(accel / G0, 1)} g</Label>
        </g>
      )}
    </g>
  );
}

export function FeedSchematic({ series, cursor, setCursor, thrustAt, accelAt, empty = false, nozzleAt, gaugeZeroPsia = 14.6959 }: SchematicProps) {
  const reducedMotion = useReducedMotion();
  const n = series.t.length;
  const i = Math.min(Math.max(cursor, 0), Math.max(n - 1, 0));
  const firing = !empty && !!series.firing[i];
  const regKey = Object.keys(series.regulators)[0];
  const thrust = (k: number) => (thrustAt ? thrustAt(k) : undefined) ?? (series.firing[k] ? series.chamber.thrust_N[k] : 0);
  const scale = useMemo(() => {
    let fmax = 1;
    let pcmax = 1;
    for (let k = 0; k < n; k++) {
      if (!series.firing[k]) continue;
      fmax = Math.max(fmax, (thrustAt ? thrustAt(k) : undefined) ?? series.chamber.thrust_N[k] ?? 0);
      pcmax = Math.max(pcmax, series.chamber.pc_psia[k] ?? 0);
    }
    return { fmax, pcmax, copv0: series.copv_psia[0] || 1 };
  }, [series, n, thrustAt]);

  // ---- playback
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.5);
  // The dashes move only while the burn plays: a still result does not crawl for ever.
  const reduced = reducedMotion || !playing;
  const raf = useRef<number | null>(null);
  const clock = useRef<{ wall: number; t: number } | null>(null);
  useEffect(() => {
    if (!playing || empty || n < 2) return;
    const t0 = series.t[0];
    const t1 = series.t[n - 1];
    let start = series.t[i];
    if (start >= t1 - 1e-9) { start = t0; setCursor(0); }
    clock.current = { wall: performance.now(), t: start };
    const tick = (now: number) => {
      const c = clock.current!;
      const t = c.t + ((now - c.wall) / 1000) * speed;
      if (t >= t1) { setCursor(n - 1); setPlaying(false); return; }
      // the step whose time has been reached
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (series.t[mid] <= t) lo = mid; else hi = mid - 1; }
      setCursor(lo);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, empty, n]);

  const at = <T,>(arr: T[] | undefined): T | undefined => (empty || !arr ? undefined : arr[i]);
  const ox = series.ox;
  const fu = series.fuel;
  const t = series.t[i] ?? 0;
  const reg = regKey ? at(series.regulators[regKey].outlet_psia) : undefined;
  const pc = firing ? series.chamber.pc_psia[i] : undefined;
  const F = firing ? thrust(i) : 0;
  const mdotO = firing ? ox.mdot[i] : 0;
  const mdotF = firing ? fu.mdot[i] : 0;
  const lossO = firing ? ox.tank_psia[i] - ox.inlet_psia[i] : undefined;
  const lossF = firing ? fu.tank_psia[i] - fu.inlet_psia[i] : undefined;
  const accel = accelAt && firing ? accelAt(t) : undefined;
  const copv = at(series.copv_psia);
  // Gas leaving the bottle [kg/s], from its own mass: the press lines' dashes run at it.
  const gasRate = useMemo(() => {
    const m = series.copv_mass_kg;
    const rates: number[] = [];
    for (let k = 1; k < n; k++) {
      const dt = series.t[k] - series.t[k - 1];
      rates.push(series.firing[k] && dt > 0 && m?.[k] !== undefined ? Math.max(0, (m[k - 1] - m[k]) / dt) : 0);
    }
    const firingRates = rates.filter((r) => r > 0);
    const mean = firingRates.length ? firingRates.reduce((a, b) => a + b, 0) / firingRates.length : 0;
    return { rates, mean };
  }, [series, n]);
  const gas = i > 0 && gasRate.mean > 0 ? gasRate.rates[i - 1] / gasRate.mean : 0;
  const glow = pc ? Math.min(1, pc / scale.pcmax) : 0;
  const plumeSize = F > 0 ? 40 + 90 * Math.min(1, F / scale.fmax) : 0;
  const nozzle = firing && nozzleAt ? nozzleAt(i) : undefined;
  const jet = nozzle ? plume(nozzle) : null;
  const heat = nozzle?.te_K ? Math.min(1, Math.max(0.35, nozzle.te_K / 2400)) : 0.8;

  return (
    <div>
      <svg viewBox="0 0 1180 330" className="w-full h-auto select-none" role="img"
           aria-label={empty ? 'Feed system schematic' : `Feed system at t = ${fmt(t, 2)} s`}>
        <style>{'@keyframes lxflow { to { stroke-dashoffset: -28; } }'}</style>
        <defs>
          <linearGradient id="lx-plume" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#fde68a" stopOpacity="0.95" />
            <stop offset="0.35" stopColor="#fb923c" stopOpacity="0.7" />
            <stop offset="1" stopColor="#fb923c" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="lx-glow" cx="0.45" cy="0.5" r="0.6">
            <stop offset="0" stopColor="#fb923c" stopOpacity="0.85" />
            <stop offset="1" stopColor="#fb923c" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* bottle */}
        <rect x={38} y={95} width={64} height={140} rx={32} fill="var(--color-bg-primary)" stroke={LINE} strokeWidth={1.5} />
        <rect x={38} y={95} width={64} height={140} rx={32} fill={REG} fillOpacity={copv ? 0.08 + 0.3 * Math.min(1, copv / scale.copv0) : 0.05} />
        <Label x={70} y={84} color={MUTED} size={11}>Bottle</Label>
        <Label x={70} y={163} size={13} weight={600}>{copv === undefined ? '—' : fmt(copv - gaugeZeroPsia, 0)}</Label>
        <Label x={70} y={178} size={10} color={MUTED}>psig</Label>

        {/* bottle to regulator */}
        <Flow d="M102 165 H172" color={REG} rate={firing ? gas : 0} still={reduced} />
        <circle cx={195} cy={165} r={22} fill="var(--color-bg-primary)" stroke={REG} strokeWidth={1.5} />
        <path d="M183 177 L207 153 M199 153 H207 V161" stroke={REG} strokeWidth={1.5} fill="none" />
        <Label x={195} y={206} color={MUTED} size={11}>Regulator</Label>
        <Label x={195} y={222} size={12} weight={600}>{reg === undefined ? '—' : `${fmt(reg, 0)} psia`}</Label>

        {/* press lines to the tank tops */}
        <Flow d="M217 165 H250 V60 H290" color={REG} rate={firing ? gas * 0.6 : 0} still={reduced} />
        <Flow d="M250 165 V215 H290" color={REG} rate={firing ? gas * 0.4 : 0} still={reduced} />

        <Tank x={290} y={30} w={84} h={124} level={at(ox.fill_fraction) ?? 0} color={LOX} name="LOX"
              psia={at(ox.tank_psia)} kg={at(ox.liquid_kg)} accel={accel} />
        <Tank x={290} y={180} w={84} h={124} level={at(fu.fill_fraction) ?? 0} color={FUEL} name="Fuel"
              psia={at(fu.tank_psia)} kg={at(fu.liquid_kg)} />

        {/* feed lines to the injector */}
        <Flow d="M374 140 H640 L700 152" color={LOX} rate={mdotO} still={reduced} />
        <Flow d="M374 290 H640 L700 198" color={FUEL} rate={mdotF} still={reduced} />
        <Label x={507} y={128} size={11} color={MUTED}>{firing ? `${fmt(mdotO, 2)} kg/s · line ${(lossO ?? 0) >= 0 ? '−' : '+'}${fmt(Math.abs(lossO ?? NaN), 1)} psi` : 'LOX main shut'}</Label>
        <Label x={507} y={278} size={11} color={MUTED}>{firing ? `${fmt(mdotF, 2)} kg/s · line ${(lossF ?? 0) >= 0 ? '−' : '+'}${fmt(Math.abs(lossF ?? NaN), 1)} psi` : 'fuel main shut'}</Label>

        {/* injector */}
        <rect x={700} y={118} width={12} height={112} rx={3} fill="var(--color-bg-tertiary)" stroke={LINE} />
        <Label x={706} y={108} size={11} color={MUTED}>Injector</Label>
        <Label x={690} y={170} size={11} anchor="end" color={LOX}>{firing ? fmt(ox.manifold_psia[i], 0) : ''}</Label>
        <Label x={690} y={186} size={11} anchor="end" color={FUEL}>{firing ? fmt(fu.manifold_psia[i], 0) : ''}</Label>

        {/* chamber and nozzle */}
        <path d="M712 134 H800 L832 160 L832 188 L800 214 H712 Z" fill="var(--color-bg-primary)" stroke={LINE} strokeWidth={1.5} />
        <rect x={712} y={134} width={118} height={80} fill="url(#lx-glow)" opacity={glow} />
        <path d="M832 160 L880 136 L880 212 L832 188 Z" fill="var(--color-bg-primary)" stroke={LINE} strokeWidth={1.5} />
        <Label x={760} y={166} size={13} weight={600}>{pc === undefined ? '—' : `${fmt(pc, 0)} psia`}</Label>
        <Label x={760} y={184} size={11} color={MUTED}>{nozzle?.tc_K ? `${fmt(nozzle.tc_K, 0)} K` : ''}</Label>
        <Label x={790} y={244} size={11} color={MUTED}>{firing ? `O/F ${fmt(series.chamber.mr[i], 2)}` : 'Chamber'}</Label>

        {/* plume: from the nozzle's state when the burn was replayed, else scaled with thrust */}
        {jet ? (
          <>
            {jet.regime === 'separated' && (
              <path d="M858 147 L868 141 M858 201 L868 207" stroke="var(--color-danger)" strokeWidth={2} />
            )}
            <PlumeShape p={jet} strength={0.35 + 0.65 * Math.min(1, F / scale.fmax)} heat={heat} />
            <Label x={1000} y={112} size={13} weight={600}>{`${fmt(F / 1000, 2)} kN`}</Label>
            <Label x={1000} y={252} size={11} color={REGIME_COLOR[jet.regime]}>
              {jet.regime === 'ideal' ? 'ideally expanded' : jet.regime === 'separated' ? 'flow separated in the nozzle' : jet.regime}
              {` · Pe/Pa ${fmt(jet.ratio, 2)}`}
            </Label>
            <Label x={1000} y={268} size={10} color={MUTED}>
              {`Pe ${fmt(nozzle!.pe_psia, 1)} · Pa ${fmt(nozzle!.pa_psia, 1)} psia${nozzle?.te_K ? ` · exit ${fmt(nozzle.te_K, 0)} K` : ''}`}
            </Label>
          </>
        ) : (
          <>
            {plumeSize > 0 && (
              <path d={`M880 140 C ${880 + plumeSize * 0.4} 138, ${880 + plumeSize * 0.8} 150, ${880 + plumeSize} 174 C ${880 + plumeSize * 0.8} 198, ${880 + plumeSize * 0.4} 210, 880 208 Z`}
                    fill="url(#lx-plume)" />
            )}
            <Label x={918} y={120} size={13} weight={600}>{firing ? `${fmt(F / 1000, 2)} kN` : ''}</Label>
          </>
        )}
      </svg>

      {!empty && n > 1 && (
        <div className="mt-2 flex items-center gap-3">
          <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play the burn'}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)]">
            {playing
              ? <svg width="10" height="10" viewBox="0 0 10 10"><rect x="1" y="1" width="3" height="8" fill="currentColor" /><rect x="6" y="1" width="3" height="8" fill="currentColor" /></svg>
              : <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 1 L9 5 L2 9 Z" fill="currentColor" /></svg>}
          </button>
          <input type="range" min={0} max={n - 1} step={1} value={i} aria-label="Time in the burn"
                 aria-valuetext={t < 0 ? `${fmt(-t, 2)} seconds before Fire` : `${fmt(t, 2)} seconds after Fire`}
                 onChange={(e) => { setPlaying(false); setCursor(Number(e.target.value)); }}
                 className="flex-1 accent-[var(--color-accent)]" />
          <span className="w-20 text-right text-[12px] tabular-nums text-[var(--color-text-secondary)]">{t < 0 ? `T−${fmt(-t, 2)} s` : `T+${fmt(t, 2)} s`}</span>
          <button type="button" onClick={() => setSpeed((s) => (s === 1 ? 0.5 : s === 0.5 ? 0.25 : 1))}
                  title="Playback speed" className="w-12 rounded border border-[var(--color-border)] py-0.5 text-[11px] tabular-nums text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            {speed === 1 ? '1×' : speed === 0.5 ? '½×' : '¼×'}
          </button>
        </div>
      )}
    </div>
  );
}
