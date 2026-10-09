// Scratch QA page for the shared layers (charts, ui, timeline) -- synthetic data only. Served by
// the dev server at /e2e-scratch/lab/charts-lab.html?theme=dark|light&units=stand|si|imperial.
import '../../src/index.css';
import '../../src/components/lx/fonts';
import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Chart } from '../../src/components/lx/charts/Chart';
import { Heatmap } from '../../src/components/lx/charts/Heatmap';
import { XYChart } from '../../src/components/lx/charts/XYChart';
import type { ChartSeries } from '../../src/components/lx/charts/types';
import type { XYSeries } from '../../src/components/lx/charts/xyTypes';
import { Timeline } from '../../src/components/lx/time/Timeline';
import { TimeProvider } from '../../src/components/lx/time/TimeProvider';
import type { TimeEvent } from '../../src/components/lx/time/store';
import * as ui from '../../src/components/lx/ui';
import { PRESETS, UnitsProvider, useUnits, type UnitSystem } from '../../src/components/lx/units';

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const sys: UnitSystem = PRESETS[(q.get('units') as keyof typeof PRESETS) ?? 'stand'] ?? PRESETS.stand;
const only = q.get('only');

const range = (a: number, b: number, d: number) => Array.from({ length: Math.round((b - a) / d) + 1 }, (_, i) => Number((a + i * d).toFixed(6)));
const noise = (i: number, k: number) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return 2 * (x - Math.floor(x)) - 1; };
const BURNOUT = 3.62;
const T = range(-0.5, 3.9, 0.01);
const fire = (x: number) => x >= 0 && x <= BURNOUT;

const EVENTS: TimeEvent[] = [
  { t: -0.5, key: 't0', label: 'T−0', kind: 't0' },
  { t: -0.15, key: 'lead', label: 'Fuel lead', kind: 'lead' },
  { t: 0, key: 'fire', label: 'Fire', kind: 'fire' },
  { t: 0.04, key: 'ign', label: 'Ignition', kind: 'ignition' },
  { t: 0.06, key: 'minchug', label: 'Min chug', kind: 'min' },
  { t: 0.12, key: 'stiff', label: 'Min ΔP/Pc', kind: 'min' },
  { t: 0.5, key: 'w1', label: 'Regulator wide open', kind: 'warn' },
  { t: 0.52, key: 'w2', label: 'LOX tank low', kind: 'warn' },
  { t: 3.55, key: 'fdry', label: 'Fuel dry', kind: 'dry' },
  { t: BURNOUT, key: 'loxdry', label: 'LOX dry', kind: 'dry' },
  { t: BURNOUT, key: 'burnout', label: 'Burnout', kind: 'burnout' },
];

function Panel({ title, children, span = 6 }: { title: string; children: React.ReactNode; span?: number }) {
  return <ui.Panel title={title} className={`lg:col-span-${span}`} bodyClassName="!pt-1">{children}</ui.Panel>;
}

function Lab() {
  const u = useUnits();
  const d = useMemo(() => {
    const pc = T.map((x, i) => (fire(x) ? 395 - 6 * Math.exp(-((x - 0.5) ** 2) / 0.1) + 0.5 * noise(i, 1) : null));
    const stiffO = T.map((x, i) => (fire(x) ? 31 + 2 * (x / BURNOUT) - 3 * Math.exp(-((x - 0.12) ** 2) / 0.004) + 0.2 * noise(i, 2) : null));
    const stiffF = T.map((x, i) => (fire(x) ? 29 + 2.5 * (x / BURNOUT) + 0.2 * noise(i, 3) : null));
    const ghostO = T.map((x) => (fire(x) ? 33 + 1.5 * (x / BURNOUT) : null));
    let wi = -1;
    stiffO.forEach((v, i) => { if (v !== null && (wi < 0 || v < (stiffO[wi] as number))) wi = i; });
    const tank = T.map((x, i) => 578 - (x > 0 ? 14 * (1 - Math.exp(-x / 0.2)) - 4 * Math.min(x, BURNOUT) : 0) + 0.4 * noise(i, 4));
    const chug = T.map((x) => (fire(x) ? 1.24 - 0.05 * Math.exp(-((x - 0.8) ** 2) / 0.2) + 0.012 * x : null));
    let ci = -1;
    chug.forEach((v, i) => { if (v !== null && (ci < 0 || v < (chug[ci] as number))) ci = i; });
    // Bode / Nyquist of L(jw) = K e^{-jw tau} / (1 + jw T1)
    const f = range(0, 3, 0.01).map((e) => 10 ** e);
    const K = 0.82, tau = 0.0021, T1 = 0.0012;
    const L = f.map((hz) => { const w = 2 * Math.PI * hz; const den = 1 + (w * T1) ** 2; const re0 = 1 / den, im0 = -w * T1 / den; const c = Math.cos(-w * tau), s = Math.sin(-w * tau); return [K * (re0 * c - im0 * s), K * (re0 * s + im0 * c)]; });
    const mag = L.map(([a, b]) => Math.hypot(a, b));
    const re = L.map((p) => p[0]); const im = L.map((p) => p[1]);
    let ni = 0;
    L.forEach(([a, b], i) => { if (Math.abs(b) < 0.02 && a < 0 && (ni === 0 || Math.hypot(a + 1, b) < Math.hypot(L[ni][0] + 1, L[ni][1]))) ni = i; });
    // Operating map: Isp(O/F, Pc) contours, the burn's path.
    const ofs = range(1.2, 1.8, 0.02), pcs = range(300, 450, 5);
    const isp = ofs.map((o) => pcs.map((p) => 236 - 40 * (o - 1.52) ** 2 + 9 * Math.log(p / 380)));
    const tf = T.filter(fire);
    const pathOF = tf.map((x) => 1.53 - 0.04 * Math.exp(-x / 0.3) + 0.01 * x / BURNOUT);
    const pathPc = tf.map((x) => 395 - 6 * Math.exp(-((x - 0.5) ** 2) / 0.1) - 2 * x);
    // Heatmap q(t, x)
    const ht = range(0, 3.6, 0.02), hs = range(0, 200, 5);
    const hz = ht.map((tt) => hs.map((s) => (3.5 + 1.2 * (1 - Math.exp(-tt / 0.3))) * Math.exp(-((s - 120) ** 2) / 600) + 0.6 + 0.3 * (s / 200)));
    return { pc, stiffO, stiffF, ghostO, wi, tank, chug, ci, f, mag, re, im, ni, ofs, pcs, isp, tf, pathOF, pathPc, ht, hs, hz };
  }, []);

  const stiffSeries: ChartSeries[] = useMemo(() => [
    { key: 'g', label: '', color: '', ghost: true, values: d.ghostO },
    { key: 'stiff_lox', label: 'LOX', color: '--lx-lox', values: d.stiffO },
    { key: 'stiff_fuel', label: 'Fuel', color: '--lx-fuel', values: d.stiffF },
  ], [d]);
  const tankSeries: ChartSeries[] = useMemo(() => [{ key: 'tank', label: 'LOX tank', color: '--lx-lox', values: d.tank }], [d]);
  const chugSeries: ChartSeries[] = useMemo(() => [{ key: 'chug', label: 'Chug margin', color: '--lx-text', values: d.chug }], [d]);
  const bode: ChartSeries[] = useMemo(() => [{ key: 'mag', label: '|L|', color: '--lx-text', values: d.mag }], [d]);
  const nyq: XYSeries[] = useMemo(() => [{ key: 'L', label: 'L(jω)', color: '--lx-hot', x: d.re, y: d.im, meta: d.f, metaUnit: 'Hz' }], [d]);
  const path: XYSeries[] = useMemo(() => [{ key: 'burn', label: 'Burn', color: '--lx-text', x: d.pathOF, y: d.pathPc, t: d.tf, width: 2 }], [d]);
  const heat = useMemo(() => ({ x: d.ofs, y: d.pcs, z: d.isp, unit: 's', name: 'Isp', contours: { count: 6 }, digits: 0 }), [d]);
  const marks = useMemo(() => [{ x: 1.5, y: 400, label: 'Design', shape: 'diamond' as const }], []);
  const region = useMemo(() => [{ points: [[1.2, 300], [1.8, 300], [1.8, 330], [1.2, 345]] as [number, number][], status: 'bad' as const, label: 'Chug-unstable' }], []);
  const lines = useMemo(() => [{ axis: 'x' as const, value: 1.7, status: 'warn' as const, label: 'Fuel ΔP/Pc 20 %' }, { axis: 'y' as const, value: 430, status: 'warn' as const, label: 'Tank cap' }], []);
  const nyMarks = useMemo(() => [{ x: -1, y: 0, label: '−1', shape: 'cross' as const, color: '--lx-bad' }], []);

  const bars = useMemo(() => {
    const specs: { label: string; v: number; spec: ui.LimitSpec; unit: string; termKey?: 'stiffness' | 'chugMargin' }[] = [
      { label: 'LOX injector ΔP/Pc', v: 28.6, spec: { limit: 20, direction: 'higher-is-safer', far: { warn: 40 } }, unit: '%', termKey: 'stiffness' },
      { label: 'Fuel injector ΔP/Pc', v: 43.1, spec: { limit: 20, direction: 'higher-is-safer', far: { warn: 40 } }, unit: '%', termKey: 'stiffness' },
      { label: 'Chug margin', v: 1.2, spec: { limit: 1, warn: 1.2, direction: 'higher-is-safer' }, unit: '', termKey: 'chugMargin' },
      { label: 'LOX tank peak against its MAWP and the design cap set in the drawing', v: 612, spec: { limit: 650, warn: 600, direction: 'lower-is-safer' }, unit: 'psia' },
      { label: 'Bottle over lockup at burnout', v: 2207, spec: { limit: 100, warn: 200, direction: 'higher-is-safer' }, unit: 'psi' },
      { label: 'Fuel tank sag', v: 71, spec: { limit: 60, warn: 30, direction: 'lower-is-safer' }, unit: 'psi' },
    ];
    return specs.map((s) => ({ ...s, scale: ui.marginScale(s.spec, s.v, { trackPx: 260 }) }));
  }, []);

  const show = (k: string) => !only || only.split(',').includes(k);
  return (
    <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-12" style={{ maxWidth: 1600 }}>
      {show('time') && <Panel title="Injector ΔP/Pc"><Chart t={T} series={stiffSeries} yUnit="%" height={240} digits={1} events={EVENTS}
        band={{ lo: 20, hi: 40, status: 'ok' }} limits={[{ value: 15, status: 'bad', label: 'min 15 %' }]} spans={[{ from: 0, to: 0.3 }]}
        worst={{ seriesKey: 'stiff_lox', index: d.wi, text: `min ${d.stiffO[d.wi]?.toFixed(1)} % at T+${T[d.wi].toFixed(2)} s` }} /></Panel>}
      {show('time') && <Panel title="Chug margin"><Chart t={T} series={chugSeries} yUnit="" height={240} digits={2} events={EVENTS}
        limits={[{ value: 1, status: 'bad', label: 'unstable below 1' }, { value: 1.2, status: 'warn', label: '1.2' }]}
        worst={{ seriesKey: 'chug', index: d.ci, text: `min ${d.chug[d.ci]?.toFixed(2)} at T+${T[d.ci].toFixed(2)} s` }} /></Panel>}
      {show('units') && <Panel title={`LOX tank (quantity, ${u.system.pressure})`}><Chart t={T} series={tankSeries} yUnit="psia" quantity="pressure" height={220} events={EVENTS}
        limits={[{ value: 600, status: 'warn', label: 'MEOP' }]} /></Panel>}
      {show('bode') && <Panel title="Loop gain"><Chart t={d.f} series={bode} yUnit="" xLog xLabel="Hz" height={220} digits={2} limits={[{ value: 1, status: 'bad', label: '1' }]} /></Panel>}
      {show('nyquist') && <Panel title="Nyquist at the worst moment" span={5}><XYChart title="Nyquist" series={nyq} marks={nyMarks} xName="Re" yName="Im" xUnit="" yUnit="" equalAspect height={300}
        worst={{ seriesKey: 'L', index: d.ni, text: `crosses at ${d.re[d.ni].toFixed(2)}, ${d.f[d.ni].toFixed(0)} Hz` }} /></Panel>}
      {show('map') && <Panel title="Operating map" span={7}><XYChart title="Operating map" series={path} heat={heat} marks={marks} regions={region} lines={lines}
        xName="O/F" yName="Pc" xUnit="" yUnit="psia" height={300} /></Panel>}
      {show('heat') && <Panel title="Heat flux along the wall" span={12}><Heatmap t={d.ht} s={d.hs} z={d.hz} name="q" unit="MW/m²" sName="x" sUnit="mm" colormap="magma" events={EVENTS} height={260} title="Heat flux" /></Panel>}
      {show('bars') && <Panel title="Limits" span={7}><div className="-mx-2"><ui.MarginList items={bars.map((b) => ({
        key: b.label, label: b.label, value: `${b.v}${b.unit ? ' ' + b.unit : ''}`, status: b.scale.status, scale: b.scale, termKey: b.termKey,
        limitText: b.spec.far ? `${b.spec.limit}–${b.spec.far.warn} ${b.unit}` : `${b.spec.direction === 'higher-is-safer' ? '≥' : '≤'} ${b.spec.limit} ${b.unit}`,
        worstText: 'at T+0.12 s', onJump: () => {},
      }))} /></div></Panel>}
      {show('figures') && <Panel title="Figures" span={5}><div className="grid grid-cols-2 gap-6">
        <ui.Figure label="Mean thrust" q={u.f(6970)} delta="+1.2 %" sub="6,779 N – 7,229 N" />
        <ui.Figure label="A very long figure label that must truncate cleanly" q={u.p(578)} sub="a very long sub-line that truncates with its full text in a tooltip" />
      </div></Panel>}
    </div>
  );
}

function Shell() {
  return (
    <div className="lx min-h-screen" data-theme={theme}>
      <UnitsProvider initial={sys} persist={false}>
        <TimeProvider series={T} events={EVENTS}>
          <Lab />
          <div className="mx-6 mb-6"><Timeline /></div>
        </TimeProvider>
      </UnitsProvider>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><Shell /></StrictMode>);
