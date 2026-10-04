// Wave-2 visual QA of the whole Layer X UI at ?lx=2 (agent "qa"). One script, every state:
//   burn      every Burn page on the latest saved run
//   compare   every Burn page with &vs=<the run before it>
//   imperial  every Burn page in psi / lbf / lb / in
//   tools     Injector and Optimize
//   empty     ?lx=2 with nothing opened (the guided start)
//   running   a running run, the backend's answer stubbed (nothing is started)
//   failed    a failed run, stubbed, details open
// Each shot is the main column at full height (the viewport grows to fit it). Geometry checks
// (overlap / clipped / orphan / ellipsis), console errors and, with AXE=1, axe over `.lx`.
// Env: OUT, SIZES ("1440x900,1920x1080"), THEMES ("dark,light"), SETS, PAGES, AXE, RUN, VS.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import { geometry } from './qa-geometry.mjs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = process.env.OUT ?? new URL('./shots/wave2/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = (process.env.SIZES ?? '1440x900,1920x1080').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const SETS = (process.env.SETS ?? 'burn,compare,imperial,tools,empty,running,failed').split(',').filter(Boolean);
const PAGES = (process.env.PAGES ?? 'overview,feed,engine,hardware,flight,stand,uncertainty,record').split(',').filter(Boolean);
const AXE = process.env.AXE === '1';
const FULL = (process.env.FULL ?? '1') === '1';

const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const done = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
const RUN = process.env.RUN ?? done[0].id;
const VS = process.env.VS ?? done[1]?.id ?? '';
const real = done.find((r) => r.id === RUN) ?? done[0];

const report = { run: RUN, vs: VS, shots: [], console: [], axe: [], overlap: [], clipped: [], ellipsis: [], orphan: [] };
const IMPERIAL = JSON.stringify({ pressure: 'psi', force: 'lbf', mass: 'lb', length: 'in', temp: 'K' });

const fake = (id, over) => ({ id, kind: 'run', status: 'running', stage: 'Nozzle erosion, pass 2', progress: 0.46, error: null,
  started: Date.now() / 1000 - 37, finished: null, design: '', settings: { ...real.settings, flight: true, replay: true }, ...over });
const FAILED_ERR = 'The T-0 state did not settle: the regulator never locked up (dome 513 psig against a 4 psi bottle).\n'
  + 'Traceback (most recent call last):\n  File "engine/layerx/analysis.py", line 812, in settle\n    raise SettleError(...)';

const browser = await chromium.launch();

async function context(W, H, theme, { view = 'burn', units = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript(([t, v, u]) => {
    try {
      const k = 'engine-design.view.v1';
      const s = JSON.parse(localStorage.getItem(k) || '{}');
      s['lx.theme'] = t;
      s['layerx.view'] = v;
      localStorage.setItem(k, JSON.stringify(s));
      if (u) localStorage.setItem('engine-design.lx.units.v1', u);
    } catch { /* */ }
  }, [theme, view, units]);
  const page = await ctx.newPage();
  const tag = `${W}-${theme}`;
  page.on('pageerror', (e) => report.console.push({ tag, type: 'pageerror', text: e.message.slice(0, 300) }));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') report.console.push({ tag, type: m.type(), text: m.text().slice(0, 300), url: page.url().slice(22, 120) });
  });
  page.on('response', (r) => { if (r.status() >= 500) report.console.push({ tag, type: '5xx', text: r.url().slice(0, 200) }); });
  return { ctx, page };
}

async function check(page, tag) {
  const g = await page.evaluate(geometry, '.lx');
  for (const k of ['overlap', 'clipped', 'ellipsis', 'orphan']) for (const x of g[k]) report[k].push({ tag, ...x });
  if (AXE) {
    try {
      const res = await new AxeBuilder({ page }).include('.lx').analyze();
      for (const v of res.violations) {
        report.axe.push({ tag, id: v.id, impact: v.impact, n: v.nodes.length, help: v.help,
          nodes: v.nodes.slice(0, 6).map((x) => `${x.target.join(' ')} :: ${(x.failureSummary ?? '').split('\n').slice(1, 2).join(' ').slice(0, 200)}`) });
      }
    } catch (e) { report.axe.push({ tag, id: 'axe-error', help: String(e).slice(0, 200) }); }
  }
}

/** Grow the viewport to the main column's full height, check, shoot, shrink back. */
async function shoot(page, W, H, tag) {
  if (FULL) {
    const extra = await page.evaluate(() => { const el = document.querySelector('.lx [data-lx-main]'); return el ? el.scrollHeight - el.clientHeight : 0; });
    if (extra > 4) { await page.setViewportSize({ width: W, height: H + extra }); await page.waitForTimeout(700); }
  }
  await check(page, tag);
  const f = `${OUT}${tag}.png`;
  await page.screenshot({ path: f });
  report.shots.push(f);
  await page.setViewportSize({ width: W, height: H });
  console.log('shot', tag);
}

async function burnPages(W, H, theme, set) {
  const { ctx, page } = await context(W, H, theme, { units: set === 'imperial' ? IMPERIAL : null });
  for (const p of PAGES) {
    const tag = `${set}-${p}-${W}-${theme}`;
    await page.setViewportSize({ width: W, height: H });
    await page.goto(`${BASE}/?lx=2&run=${RUN}&page=${p}${set === 'compare' && VS ? `&vs=${VS}` : ''}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForSelector('.lx-tl-readout', { timeout: 60000 }).catch(() => console.log('no timeline', tag));
    await page.waitForTimeout(1800);
    await shoot(page, W, H, tag);
  }
  await ctx.close();
}

for (const [W, H] of SIZES) {
  for (const theme of THEMES) {
    for (const set of SETS) {
      if (set === 'burn' || set === 'compare' || set === 'imperial') { await burnPages(W, H, theme, set); continue; }
      if (set === 'tools') {
        for (const tool of ['injector', 'optimize']) {
          const { ctx, page } = await context(W, H, theme, { view: tool === 'injector' ? 'reconcile' : 'optimise' });
          await page.goto(`${BASE}/?lx=2&run=${RUN}`, { waitUntil: 'load', timeout: 60000 });
          await page.waitForSelector('.lx-tl-readout', { timeout: 60000 }).catch(() => {});
          await page.getByRole('radiogroup', { name: 'Layer X tool' }).getByRole('radio', { name: tool === 'injector' ? 'Injector' : 'Optimize' }).click();
          await page.waitForTimeout(3500);
          await shoot(page, W, H, `tools-${tool}-${W}-${theme}`);
          await ctx.close();
        }
        continue;
      }
      const { ctx, page } = await context(W, H, theme);
      if (set === 'empty') {
        await page.goto(`${BASE}/?lx=2`, { waitUntil: 'load', timeout: 60000 });
        await page.waitForSelector('.lx', { timeout: 60000 });
        await page.waitForTimeout(2500);
      } else if (set === 'running') {
        await page.route('**/api/layerx/runs/FAKE-RUNNING', (r) => r.fulfill({ json: fake('FAKE-RUNNING') }));
        await page.goto(`${BASE}/?lx=2&run=FAKE-RUNNING`, { waitUntil: 'load', timeout: 60000 });
        await page.waitForSelector('[aria-label="The burn is running"]', { timeout: 60000 }).catch(() => console.log('no running panel'));
        await page.waitForTimeout(1200);
      } else if (set === 'failed') {
        await page.route('**/api/layerx/runs/FAKE-FAILED', (r) => r.fulfill({ json: fake('FAKE-FAILED', { status: 'failed', stage: 'Burning, pass 1', error: FAILED_ERR }) }));
        await page.goto(`${BASE}/?lx=2&run=FAKE-FAILED`, { waitUntil: 'load', timeout: 60000 });
        await page.waitForTimeout(1500);
        await page.getByRole('button', { name: 'Details' }).click().catch(() => console.log('no details button'));
        await page.waitForTimeout(300);
      }
      await shoot(page, W, H, `${set}-${W}-${theme}`);
      await ctx.close();
    }
  }
}

await browser.close();
const name = process.env.REPORT ?? 'report';
fs.writeFileSync(`${OUT}${name}.json`, JSON.stringify(report, null, 1));
console.log(['console', 'axe', 'overlap', 'clipped', 'ellipsis', 'orphan'].map((k) => `${k}: ${report[k].length}`).join(' · '));
for (const k of ['console', 'axe', 'overlap', 'clipped', 'orphan']) for (const x of report[k].slice(0, 15)) console.log(k, JSON.stringify(x).slice(0, 300));
