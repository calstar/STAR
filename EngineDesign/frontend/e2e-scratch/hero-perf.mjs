// Scratch: scrub the hero's time cursor once per animation frame for ~3 s and report frame times.
// The harness exposes its TimeStore as window.__store.
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const QS = process.env.QS ?? '&match=1';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(`${BASE}/e2e-scratch/hero.html?theme=dark&w=1104${QS}`, { waitUntil: 'load', timeout: 60000 });
await page.waitForSelector('svg[aria-label="Feed system schematic"]', { timeout: 60000 });
await page.waitForTimeout(1500);
const r = await page.evaluate(async () => {
  const store = window.__store;
  const { series } = store.get();
  const t0 = series[0];
  const t1 = series[series.length - 1];
  const frames = [];
  let last = performance.now();
  for (let k = 0; k < 180; k++) {
    store.setT(t0 + ((t1 - t0) * (k % 90)) / 89);
    await new Promise((res) => requestAnimationFrame(res));
    const now = performance.now();
    frames.push(now - last);
    last = now;
  }
  frames.sort((a, b) => a - b);
  const mean = frames.reduce((a, b) => a + b, 0) / frames.length;
  return { n: series.length, mean: mean.toFixed(2), p50: frames[90].toFixed(2), p95: frames[171].toFixed(2), max: frames[179].toFixed(2) };
});
console.log(JSON.stringify(r));
await browser.close();
