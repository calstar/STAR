// Scratch visual QA for the Burn pages against the DATA-CONTRACT (agent "pages"). Screenshots the
// main column at full height, plus the geometry checks (overlap / clipped / orphan) and console
// errors. FIXTURE=1 opens the run with &lxfixture=contract (dev/contractFixture.ts) and serves a
// made-up axial sidecar. Env: PAGES, SIZES ("1440x900"), THEMES ("dark"), FIXTURE, RUN, OUT, TAG.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { geometry } from './qa-geometry.mjs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = process.env.OUT ?? new URL('./shots/pages/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = (process.env.SIZES ?? '1440x900').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark').split(',');
const PAGES = (process.env.PAGES ?? 'overview,feed,engine,hardware,flight,stand,uncertainty,record').split(',').filter(Boolean);
const FIXTURE = process.env.FIXTURE === '1';
const TAG = process.env.TAG ?? (FIXTURE ? 'fx' : 'real');
const CLICK = process.env.CLICK ?? '';

const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const latest = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
const RUN = process.env.RUN ?? latest[0].id;
const VS = process.env.VS === 'auto' ? latest[1]?.id ?? '' : process.env.VS ?? '';
const report = { run: RUN, console: [], overlap: [], clipped: [], orphan: [], shots: [] };

const axial = () => {
  const t = Array.from({ length: 36 }, (_, k) => k * 0.1);
  const x = Array.from({ length: 60 }, (_, k) => -160 + k * 4.6);
  return {
    x_mm: x, t,
    q_MW_m2: t.map((tt) => x.map((xx) => 2 + 9 * Math.exp(-((xx / 25) ** 2)) * (1 - 0.1 * tt / 4))),
    T_wall_K: t.map((tt) => x.map((xx) => 300 + (1500 + 800 * Math.exp(-((xx / 30) ** 2))) * (1 - Math.exp(-tt / 1.2)))),
  };
};

const browser = await chromium.launch();
for (const [W, H] of SIZES) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    if (process.env.UNITS) await ctx.addInitScript((u) => { try { localStorage.setItem('engine-design.lx.units.v1', u); } catch { /* */ } }, process.env.UNITS);
    await ctx.addInitScript(([t]) => {
      try {
        const k = 'engine-design.view.v1';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        s['lx.theme'] = t;
        s['layerx.view'] = 'burn';
        localStorage.setItem(k, JSON.stringify(s));
      } catch { /* */ }
    }, [theme]);
    const page = await ctx.newPage();
    if (FIXTURE) await page.route('**/sidecar/axial', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(axial()) }));
    page.on('response', (r) => { if (r.status() >= 500) report.console.push({ tag: `${W}-${theme}`, type: '5xx', text: r.url().slice(0, 200) }); });
    page.on('pageerror', (e) => report.console.push({ tag: `${W}-${theme}`, type: 'pageerror', text: e.message.slice(0, 300) }));
    page.on('console', (m) => { if (m.type() === 'error') report.console.push({ tag: `${W}-${theme}`, type: m.type(), text: m.text().slice(0, 300) }); });
    for (const p of PAGES) {
      const tag = `${p}-${W}-${theme}-${TAG}`;
      await page.setViewportSize({ width: W, height: H });
      await page.goto(`${BASE}/?lx=2&run=${RUN}&page=${p}${FIXTURE ? '&lxfixture=contract' : ''}${VS ? `&vs=${VS}` : ''}`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForSelector('.lx-tl-readout', { timeout: 60000 }).catch(() => console.log('no timeline'));
      await page.waitForTimeout(1500);
      if (CLICK) { await page.getByRole('button', { name: CLICK }).first().click().catch(() => {}); await page.waitForTimeout(400); }
      const extra = await page.evaluate(() => { const el = document.querySelector('.lx [data-lx-main]'); return el ? el.scrollHeight - el.clientHeight : 0; });
      if (extra > 4) { await page.setViewportSize({ width: W, height: H + extra }); await page.waitForTimeout(600); }
      const g = await page.evaluate(geometry, '.lx');
      for (const k of ['overlap', 'clipped', 'orphan']) for (const x of g[k]) report[k].push({ tag, ...x });
      const f = `${OUT}${tag}.png`;
      await page.screenshot({ path: f });
      report.shots.push(f);
      console.log('shot', f);
    }
    await ctx.close();
  }
}
await browser.close();
fs.writeFileSync(`${OUT}report-${TAG}.json`, JSON.stringify(report, null, 1));
console.log(`console ${report.console.length} overlap ${report.overlap.length} clipped ${report.clipped.length} orphan ${report.orphan.length}`);
for (const k of ['console', 'overlap', 'clipped', 'orphan']) for (const x of report[k].slice(0, 12)) console.log(k, JSON.stringify(x).slice(0, 260));
