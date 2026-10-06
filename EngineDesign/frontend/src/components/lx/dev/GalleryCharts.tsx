import '../fonts';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Chart } from '../charts/Chart';
import { MiniSpark } from '../charts/MiniSpark';
import { alignOnto, onlyWhere } from '../charts/resample';
import type { ChartEvent, ChartSeries } from '../charts/types';
import { Timeline } from '../time/Timeline';
import { TimeProvider } from '../time/TimeProvider';
import { useTimeStore } from '../time/hooks';
import { createTimeStore, type TimeEvent, type TimeStore } from '../time/store';
import { useShortcuts } from '../time/useShortcuts';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';

/**
 * Dev harness for the charts and the timeline: a realistic burn (pressures, thrust against a
 * compared run, ΔP/Pc with its band and worst point, ledger sparklines) and a load test (6 charts
 * × 5 series × 2000 points) with a frame meter and a sync benchmark, so a reviewer can check that
 * scrubbing holds 60 fps. Synthetic data only; nothing is fetched.
 */

type Theme = 'dark' | 'light';
type DataSet = 'burn' | 'load';

// ------------------------------------------------------------------ synthetic data

const range = (t0: number, t1: number, dt: number) => Array.from({ length: Math.round((t1 - t0) / dt) + 1 }, (_, i) => Number((t0 + i * dt).toFixed(6)));
/** Deterministic noise in [-1, 1]. */
const noise = (i: number, k: number) => {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return 2 * (x - Math.floor(x)) - 1;
};
const smooth = (t: number, tau: number) => (t <= 0 ? 0 : 1 - Math.exp(-t / tau));

const BURNOUT = 3.62;
const GHOST_BURNOUT = 3.48;

const BURN_EVENTS: TimeEvent[] = [
  { t: -0.5, key: 't0', label: 'T−0', kind: 't0' },
  { t: -0.15, key: 'lead', label: 'Fuel lead', kind: 'lead' },
  { t: 0, key: 'fire', label: 'Fire', kind: 'fire' },
  { t: 0.08, key: 'ign', label: 'Ignition', kind: 'ignition' },
  { t: 0.12, key: 'stiff', label: 'Min ΔP/Pc', kind: 'min' },
  { t: 1.9, key: 'chug', label: 'Min chug', kind: 'min' },
  { t: BURNOUT, key: 'lox_dry', label: 'LOX dry', kind: 'dry' },
  { t: BURNOUT, key: 'burnout', label: 'Burnout', kind: 'burnout' },
];

function burnData() {
  const t = range(-0.5, 4.2, 0.01);
  const firing = t.map((x) => x >= 0 && x <= BURNOUT);
  const dip = (x: number, depth: number) => (x < 0 ? 0 : -depth * Math.exp(-((x - 0.15) ** 2) / 0.006) - (x > BURNOUT ? -4 * smooth(x - BURNOUT, 0.1) : 0));
  const droop = (x: number, per: number) => (x < 0 ? 0 : -per * Math.min(x, BURNOUT));
  const lox = t.map((x, i) => 578 + dip(x, 30) + droop(x, 4.5) - 13 * smooth(Math.min(x, BURNOUT), 0.2) * (x > 0 ? 1 : 0) + 0.6 * noise(i, 1));
  const fuel = t.map((x, i) => 575 + dip(x, 24) + droop(x, 3.2) - 10 * smooth(Math.min(x, BURNOUT), 0.2) * (x > 0 ? 1 : 0) + 0.6 * noise(i, 2));
  const pc = t.map((x, i) => Math.max(0, 382 * smooth(x - 0.03, 0.05) - 2.5 * Math.max(0, x) + 0.8 * noise(i, 3)));
  const injO = t.map((x, i) => Math.max(0, pc[i] * (1.235 - 0.07 * Math.exp(-((x - 0.12) ** 2) / 0.002)) + 1.0 * noise(i, 4)));
  const injF = t.map((_, i) => Math.max(0, pc[i] * 1.29 + 1.0 * noise(i, 5)));
  const thrust = t.map((_, i) => Math.max(0, (pc[i] / 382) * 6.8 + 0.01 * noise(i, 6)));
  const stiffO = t.map((_, i) => (pc[i] > 20 ? ((injO[i] - pc[i]) / pc[i]) * 100 : null));
  const stiffF = t.map((_, i) => (pc[i] > 20 ? ((injF[i] - pc[i]) / pc[i]) * 100 : null));
  const of = t.map((x, i) => 1.38 + 0.02 * (x / BURNOUT) + 0.004 * noise(i, 7));

  // The compared run, on its own 20 ms clock, Fire = 0.
  const gt = range(-0.5, 4.2, 0.02);
  const gThrust = gt.map((x, i) => (x >= 0 && x <= GHOST_BURNOUT ? Math.max(0, 6.6 * smooth(x - 0.03, 0.05) - 0.03 * x + 0.01 * noise(i, 8)) : null));
  const gPc = gt.map((x, i) => (x >= 0 && x <= GHOST_BURNOUT ? Math.max(0, 371 * smooth(x - 0.03, 0.05) - 2.4 * x + 0.8 * noise(i, 9)) : null));

  const fire = (v: (number | null)[]) => onlyWhere(v, firing);
  let worstI = -1;
  firing.forEach((f, i) => {
    const v = stiffO[i];
    if (f && v !== null && (worstI < 0 || v < (stiffO[worstI] as number))) worstI = i;
  });
  return {
    t, firing,
    lox, fuel, injO: fire(injO), injF: fire(injF), pc: fire(pc),
    thrust: fire(thrust), ghostThrust: alignOnto(t, gt, gThrust), ghostPc: alignOnto(t, gt, gPc),
    stiffO: fire(stiffO), stiffF: fire(stiffF), of: fire(of), worstI,
  };
}

const LOAD_COLORS = ['--lx-lox', '--lx-fuel', '--lx-gas', '--lx-hot', '--lx-text'];

function loadData() {
  const t = range(-1, 6, 7 / 1999);
  const charts = Array.from({ length: 6 }, (_, c) => ({
    key: `load${c}`,
    series: LOAD_COLORS.map((color, k): ChartSeries => ({
      key: `c${c}s${k}`,
      label: ['LOX', 'Fuel', 'Gas', 'Hot', 'Neutral'][k],
      color,
      values: t.map((x, i) => 100 * (k + 1) + 30 * Math.sin(2 * Math.PI * (0.2 + 0.07 * k + 0.05 * c) * x + k) + 3 * noise(i, c * 10 + k)),
    })),
  }));
  return { t, charts };
}

// ------------------------------------------------------------------ meters

/** Frames per second and the worst frame over the last second, written without a React render. */
function FrameMeter() {
  const out = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let windowStart = last;
    let frames = 0;
    let worst = 0;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      frames++;
      worst = Math.max(worst, dt);
      if (now - windowStart >= 1000) {
        if (out.current) out.current.textContent = `${Math.round((frames * 1000) / (now - windowStart))} fps · worst ${worst.toFixed(1)} ms`;
        windowStart = now;
        frames = 0;
        worst = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span ref={out} className="lx-num text-[12px] text-[var(--lx-text-2)]" aria-live="off">— fps</span>;
}

/**
 * Two measurements of the cursor path: the synchronous cost of one cursor move through every
 * subscriber (charts, timeline), and the frame rate while the cursor sweeps once per frame for 3 s.
 */
function Benchmark() {
  const store = useTimeStore();
  const [result, setResult] = useState('');
  const sync = () => {
    const { range: r } = store.get();
    if (!r) return;
    const n = 400;
    const at = (i: number) => r[0] + ((r[1] - r[0]) * ((i * 37) % n)) / n;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      store.setT(at(i));
      store.flush();
    }
    const js = (performance.now() - t0) / n;
    // Again, with the style and layout each move costs the browser forced after it.
    const t1 = performance.now();
    for (let i = 0; i < n; i++) {
      store.setT(at(i + 1));
      store.flush();
      void document.body.offsetHeight;
    }
    const laid = (performance.now() - t1) / n;
    setResult(`${js.toFixed(2)} ms a cursor move · ${laid.toFixed(2)} ms with layout`);
  };
  const sweep = () => {
    const { range: r } = store.get();
    if (!r) return;
    const start = performance.now();
    let last = start;
    let worst = 0;
    let frames = 0;
    const step = (now: number) => {
      worst = Math.max(worst, now - last);
      last = now;
      frames++;
      const f = Math.min((now - start) / 3000, 1);
      store.setT(r[0] + (r[1] - r[0]) * f);
      if (f < 1) requestAnimationFrame(step);
      else setResult(`sweep ${Math.round((frames * 1000) / (now - start))} fps · worst frame ${worst.toFixed(1)} ms`);
    };
    requestAnimationFrame(step);
  };
  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={sync}>Sync cost</Button>
      <Button size="sm" onClick={sweep}>Sweep 3 s</Button>
      <span className="lx-num text-[12px] text-[var(--lx-text-2)]">{result}</span>
    </div>
  );
}

// ------------------------------------------------------------------ views

function Shortcuts({ store }: { store: TimeStore }) {
  useShortcuts(store);
  return null;
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-surface)] p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-[13px] font-medium text-[var(--lx-text)]">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** What a margin bar does when clicked: jump to the limit's worst time and flash it everywhere. */
function FocusButton({ t, k, children }: { t: number; k: string; children: ReactNode }) {
  const store = useTimeStore();
  return <Button size="sm" onClick={() => store.focus(t, k)}>{children}</Button>;
}

function BurnView() {
  const d = useMemo(() => burnData(), []);
  const pressures = useMemo<ChartSeries[]>(() => [
    { key: 'lox_tank', label: 'LOX tank', color: '--lx-lox', values: d.lox },
    { key: 'fuel_tank', label: 'Fuel tank', color: '--lx-fuel', values: d.fuel },
    { key: 'lox_inj', label: 'LOX injector', color: '--lx-lox', values: d.injO, dash: [4, 3] },
    { key: 'fuel_inj', label: 'Fuel injector', color: '--lx-fuel', values: d.injF, dash: [4, 3] },
    { key: 'pc', label: 'Chamber', color: '--lx-hot', values: d.pc },
    { key: 'pc_vs', label: '', color: '', values: d.ghostPc, ghost: true },
  ], [d]);
  const thrust = useMemo<ChartSeries[]>(() => [
    { key: 'thrust_vs', label: 'vs run 12', color: '', values: d.ghostThrust, ghost: true },
    { key: 'thrust', label: 'Thrust', color: '--lx-hot', values: d.thrust, width: 2 },
  ], [d]);
  const stiff = useMemo<ChartSeries[]>(() => [
    { key: 'stiff_lox', label: 'LOX', color: '--lx-lox', values: d.stiffO },
    { key: 'stiff_fuel', label: 'Fuel', color: '--lx-fuel', values: d.stiffF },
  ], [d]);
  const of = useMemo<ChartSeries[]>(() => [{ key: 'of', label: 'O/F', color: '--lx-text', values: d.of }], [d]);
  const band = useMemo(() => ({ lo: 20, hi: 40, status: 'ok' as const }), []);
  const limits = useMemo(() => [
    { value: 15, status: 'bad' as const, label: 'min 15 %' },
    { value: 20, status: 'warn' as const, label: '20 %' },
  ], []);
  const worst = useMemo(() => ({
    seriesKey: 'stiff_lox', index: d.worstI,
    text: `min ${(d.stiffO[d.worstI] ?? 0).toFixed(1)} % at ${d.t[d.worstI].toFixed(2)} s`,
  }), [d]);
  const events: ChartEvent[] = BURN_EVENTS;
  const store = useMemo(() => createTimeStore({ t: 1.85 }), []);

  return (
    <TimeProvider store={store} series={d.t} events={BURN_EVENTS}>
      <Shortcuts store={store} />
      <div className="grid gap-4 p-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(560px, 100%), 1fr))' }}>
        <Panel title="Pressures">
          <Chart t={d.t} series={pressures} yUnit="psia" height={300} events={events} />
        </Panel>
        <Panel title="Thrust">
          <Chart t={d.t} series={thrust} yUnit="kN" height={300} digits={2} events={events} yPin={[0, null]} />
        </Panel>
        <Panel title="Injector stiffness ΔP/Pc" right={<FocusButton t={d.t[d.worstI]} k="stiff_lox">Show worst</FocusButton>}>
          <Chart t={d.t} series={stiff} yUnit="%" height={220} band={band} limits={limits} worst={worst} digits={1} events={events} />
        </Panel>
        <Panel title="O/F">
          <Chart t={d.t} series={of} yUnit="" height={140} digits={2} events={events} />
        </Panel>
        <Panel title="Ledger sparklines">
          <div className="grid items-center gap-x-4 gap-y-2 text-[12px]" style={{ gridTemplateColumns: 'auto auto auto' }}>
            <span className="text-[var(--lx-text-2)]">Tank pressure</span>
            <span className="lx-num">578 → 548–578 psia</span>
            <MiniSpark t={d.t} values={d.lox} color="--lx-lox" band={{ lo: 570, hi: 585 }} title="LOX tank pressure over the burn" />
            <span className="text-[var(--lx-text-2)]">ΔP/Pc</span>
            <span className="lx-num">20 % → 16–30 %</span>
            <MiniSpark t={d.t} values={d.stiffO} color="--lx-lox" band={{ lo: 20, hi: 40 }} />
            <span className="text-[var(--lx-text-2)]">O/F</span>
            <span className="lx-num">1.40 → 1.38–1.40</span>
            <MiniSpark t={d.t} values={d.of} />
          </div>
        </Panel>
        <Panel title="Empty">
          <Chart t={[]} series={[]} yUnit="psia" height={140} />
        </Panel>
      </div>
      <div className="sticky bottom-0 z-10"><Timeline /></div>
    </TimeProvider>
  );
}

function LoadView() {
  const d = useMemo(() => loadData(), []);
  const store = useMemo(() => createTimeStore({ t: 2 }), []);
  return (
    <TimeProvider store={store} series={d.t} events={BURN_EVENTS}>
      <Shortcuts store={store} />
      <div className="flex items-center justify-end gap-4 px-4 pt-3">
        <Benchmark />
      </div>
      <div className="grid gap-4 p-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(520px, 100%), 1fr))' }}>
        {d.charts.map((c, k) => (
          <Panel key={c.key} title={`Load ${k + 1}: 5 × ${d.t.length}`}>
            <Chart t={d.t} series={c.series} yUnit="psia" height={220} events={BURN_EVENTS} />
          </Panel>
        ))}
      </div>
      <div className="sticky bottom-0 z-10"><Timeline /></div>
    </TimeProvider>
  );
}

export function GalleryCharts({ initialTheme = 'dark' }: { initialTheme?: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [set, setSet] = useState<DataSet>('burn');
  return (
    <div className="lx min-h-screen" data-theme={theme}>
      <header className="flex flex-wrap items-center gap-4 border-b border-[var(--lx-line)] bg-[var(--lx-surface)] px-4 py-2">
        <h1 className="text-[13px] font-medium">Charts and timeline</h1>
        <Segmented ariaLabel="Data set" value={set} onChange={setSet}
                   options={[{ value: 'burn', label: 'Burn' }, { value: 'load', label: 'Load test' }]} />
        <Segmented ariaLabel="Theme" value={theme} onChange={setTheme}
                   options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]} />
        <span className="ml-auto"><FrameMeter /></span>
      </header>
      {set === 'burn' ? <BurnView /> : <LoadView />}
    </div>
  );
}
