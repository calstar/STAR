// Scratch harness for lx/hero: the Hero (or the schematic alone) on a real saved run, inside an
// .lx root with the Layer X tokens, a TimeProvider and the docked Timeline. Not part of the app.
//   /e2e-scratch/hero.html?theme=dark&run=<id>&w=1100&t=1.75&fixture=network&only=schematic
import '../src/index.css';
import '../src/components/lx/fonts';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ChamberGeometryResponse } from '../src/api/client';
import type { LayerXResult, RunView } from '../src/api/layerx';
import { chamberRecessionAt, sectionFromGeometry, throatAreaRatioAt, wallFromGrowth } from '../src/components/lx/hero/contour';
import { Hero } from '../src/components/lx/hero/Hero';
import { Schematic } from '../src/components/lx/hero/Schematic';
import { standResult } from '../src/components/lx/hero/__fixtures__/result';
import { TimeProvider } from '../src/components/lx/time/TimeProvider';
import { Timeline } from '../src/components/lx/time/Timeline';
import { createTimeStore } from '../src/components/lx/time/store';
import { Panel } from '../src/components/lx/ui';
import { UnitsProvider } from '../src/components/lx/units';

const q = new URLSearchParams(location.search);
const theme = q.get('theme') === 'light' ? 'light' : 'dark';
const width = Number(q.get('w') ?? 0) || null;
const store = createTimeStore();
(window as unknown as { __store: typeof store }).__store = store;

async function load(): Promise<{ result: LayerXResult; drawingId: string }> {
  const runs: RunView[] = await (await fetch('/api/layerx/runs')).json();
  const done = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
  const id = q.get('run') ?? done[0].id;
  const run: RunView = await (await fetch(`/api/layerx/runs/${id}`)).json();
  let result = run.result as LayerXResult;
  const fx = q.get('fixture');
  if (fx === 'network') {
    // The fixture's feed network, with the real run's engine replay (for the section and plume).
    const real = result;
    result = { ...standResult({ n: 17, network: true, diagnostics: true }), delivered: real.delivered, replay: real.replay };
  }
  if (q.get('match') || q.get('contour')) {
    // Harness only: make the run's engine the open design's, so the section draws.
    const g: ChamberGeometryResponse = await (await fetch('/api/geometry')).json();
    const a = (Math.PI / 4) * g.D_throat ** 2;
    if (result.replay) result.replay.A_throat_m2 = result.replay.A_throat_m2.map(() => a);
    if (result.delivered?.eps) result.delivered.eps = result.delivered.eps.map(() => g.expansion_ratio);
    if (q.get('contour')) {
      const s = sectionFromGeometry(g)!;
      const dv = result.delivered!;
      const frames = { t: dv.t, r_mm: dv.t.map((t) => wallFromGrowth(s, throatAreaRatioAt(result, t) * (q.get('contour') === 'big' ? 1.3 : 1), chamberRecessionAt(result, t))) };
      const prior = (result as unknown as { diagnostics?: object }).diagnostics ?? {};
      (result as unknown as { diagnostics: unknown }).diagnostics = {
        ...prior,
        hardware: { contour: { x_mm: s.x, r0_mm: s.r0, frames, liner_r_mm: s.liner ?? undefined }, separation: { flag: q.get('sep') === '1' } },
      };
    }
  }
  return { result, drawingId: q.get('drawing') ?? result.provenance?.drawing?.id ?? run.settings.drawing_id };
}

function App() {
  const [data, setData] = useState<{ result: LayerXResult; drawingId: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { load().then(setData, (e) => setErr(String(e))); }, []);
  useEffect(() => {
    if (!data) return;
    const t = Number(q.get('t'));
    if (Number.isFinite(t) && q.has('t')) setTimeout(() => { store.setT(t); store.flush(); }, 50);
  }, [data]);
  if (err) return <pre>{err}</pre>;
  if (!data) return <div>loading</div>;
  const zero = (data.result.provenance?.derived?.ambient_pa as number | undefined) ?? 101325;
  return (
    <div className="lx" data-theme={theme} style={{ minHeight: '100vh', padding: 24, boxSizing: 'border-box' }}>
      <UnitsProvider gaugeZeroPsia={zero / 6894.757293168361} persist={false}>
        <TimeProvider store={store} series={data.result.series.t} events={[]}>
          <div style={{ width: width ?? undefined, maxWidth: 1600 }}>
            {q.get('only') === 'schematic'
              ? <Panel title="Feed system"><Schematic result={data.result} drawingId={data.drawingId} /></Panel>
              : <Hero result={data.result} drawingId={data.drawingId} />}
          </div>
          <div style={{ marginTop: 24, width: width ?? undefined }}><Timeline /></div>
        </TimeProvider>
      </UnitsProvider>
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);
