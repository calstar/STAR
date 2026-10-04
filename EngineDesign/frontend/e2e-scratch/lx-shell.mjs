// Scratch visual QA for the rebuilt Layer X shell: opens ?lx=2 on the latest saved run and
// screenshots every Burn page (and the tools) at the given width and theme. Not a test suite.
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const W = Number(process.env.W ?? 1440);
const H = Number(process.env.H ?? 900);
const THEME = process.env.THEME ?? 'dark';
const PAGES = (process.env.PAGES ?? 'overview,feed,engine,hardware,flight,stand,uncertainty,record').split(',');
const OUT = new URL('./shots/', import.meta.url).pathname;

const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const latest = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
const run = process.env.RUN ?? latest[0].id;
const vs = process.env.VS ?? '';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await ctx.addInitScript((theme) => {
  try {
    const k = 'engine-design.view.v1';
    const s = JSON.parse(localStorage.getItem(k) || '{}');
    s['lx.theme'] = theme;
    localStorage.setItem(k, JSON.stringify(s));
  } catch {}
}, THEME);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

for (const p of PAGES) {
  const url = `${BASE}/?lx=2&run=${run}&page=${p}${vs ? `&vs=${vs}` : ''}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.lx', { timeout: 20000 });
  await page.waitForTimeout(1500);
  const file = `${OUT}${p}-${W}-${THEME}${vs ? '-vs' : ''}.png`;
  await page.screenshot({ path: file, fullPage: false });
  // The main column scrolls on its own: capture its full height too.
  const full = await page.evaluate(() => {
    const el = document.querySelector('.lx .overflow-y-auto');
    return el ? el.scrollHeight : 0;
  });
  console.log(p, file, 'main scrollHeight', full, 'url', page.url());
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
