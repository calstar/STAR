// Scrub smoothness on a real Burn page (agent "qa"): drag the timeline's handle back and forth
// with the real mouse for ~2 s while the page records every animation frame, then report the frame
// rate, the slow frames and how many distinct cursor moments were drawn. Env: PAGE (overview),
// SIZE (1440x900), THEME (dark), CPU (CDP throttling rate, default 1), DUR (ms, 2000).
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const PAGE = process.env.PAGE ?? 'overview';
const [W, H] = (process.env.SIZE ?? '1440x900').split('x').map(Number);
const THEME = process.env.THEME ?? 'dark';
const CPU = Number(process.env.CPU ?? 1);
const DUR = Number(process.env.DUR ?? 2000);

const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const RUN = process.env.RUN ?? runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started)[0].id;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript((t) => { try { const k = 'engine-design.view.v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s['lx.theme'] = t; s['layerx.view'] = 'burn'; localStorage.setItem(k, JSON.stringify(s)); } catch { /* */ } }, THEME);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${BASE}/?lx=2&run=${RUN}&page=${PAGE}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('.lx-tl-readout', { timeout: 60000 });
if (PAGE === 'overview') await page.waitForSelector('svg[aria-label="Feed system schematic"]', { timeout: 60000 });
await page.waitForTimeout(2000);
if (CPU > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU }); }

const box = await page.locator('.lx-tl-track').boundingBox();
const y = box.y + box.height / 2;
const x0 = box.x + 4, x1 = box.x + box.width - 4;

// Record frames in the page while the mouse scrubs.
await page.evaluate((dur) => {
  window.__frames = [];
  window.__moments = new Set();
  const out = document.querySelector('.lx-tl-readout');
  const t0 = performance.now();
  let last = t0;
  const tick = (now) => {
    window.__frames.push(now - last);
    last = now;
    if (out) window.__moments.add(out.textContent);
    if (now - t0 < dur) requestAnimationFrame(tick);
    else window.__done = true;
  };
  requestAnimationFrame((now) => { last = now; requestAnimationFrame(tick); });
}, DUR);

await page.mouse.move(x0, y);
await page.mouse.down();
const started = Date.now();
let k = 0;
while (Date.now() - started < DUR) {
  // A full sweep every ~500 ms, one move per ~8 ms (faster than the frames, as a hand is).
  const phase = ((Date.now() - started) % 1000) / 1000;
  const f = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  await page.mouse.move(x0 + (x1 - x0) * f, y);
  k++;
}
await page.mouse.up();
await page.waitForFunction(() => window.__done === true, null, { timeout: 10000 });
const r = await page.evaluate(() => {
  const fr = window.__frames.slice(1);
  const sorted = [...fr].sort((a, b) => a - b);
  const total = fr.reduce((a, b) => a + b, 0);
  return {
    frames: fr.length,
    fps: Number((1000 * fr.length / total).toFixed(1)),
    mean_ms: Number((total / fr.length).toFixed(2)),
    p95_ms: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
    max_ms: Number(sorted[sorted.length - 1].toFixed(2)),
    over_25ms: fr.filter((x) => x > 25).length,
    moments_drawn: window.__moments.size,
  };
});
console.log(JSON.stringify({ page: PAGE, size: `${W}x${H}`, theme: THEME, cpu: CPU, mouse_moves: k, ...r, errors: errors.length }));
for (const e of errors.slice(0, 5)) console.log('error', e.slice(0, 200));
await browser.close();
