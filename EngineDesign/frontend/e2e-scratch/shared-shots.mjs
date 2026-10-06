// Scratch (shared-layers agent): screenshots of Burn pages for before/after comparisons of the
// shared chart / ui / timeline layers. Env: OUT (subdir of shots/shared), PAGES, SIZES, THEMES,
// RUN, VS, UNITS (json UnitSystem to force), FULL (1: also the main column at full height).
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = new URL(`./shots/shared/${process.env.OUT ?? 'now'}/`, import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = (process.env.SIZES ?? '1440x900').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const PAGES = (process.env.PAGES ?? 'overview,feed,engine,hardware').split(',').filter(Boolean);
const FULL = (process.env.FULL ?? '1') === '1';
const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const latest = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
const RUN = process.env.RUN ?? latest[0].id;
const VS = process.env.VS ?? '';
const errors = [];
const browser = await chromium.launch();
for (const [W, H] of SIZES) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await ctx.addInitScript(([t, units]) => {
      try {
        const k = 'engine-design.view.v1';
        const s = JSON.parse(localStorage.getItem(k) || '{}');
        s['lx.theme'] = t;
        s['layerx.view'] = 'burn';
        localStorage.setItem(k, JSON.stringify(s));
        if (units) localStorage.setItem('engine-design.lx.units.v1', units);
      } catch { /* */ }
    }, [theme, process.env.UNITS ?? '']);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${W}-${theme} pageerror ${e.message.slice(0, 200)}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${W}-${theme} console ${m.text().slice(0, 200)}`); });
    for (const p of PAGES) {
      const tag = `${p}-${W}-${theme}`;
      await page.setViewportSize({ width: W, height: H });
      // The API restarts when another agent edits the backend: retry until the console is up.
      for (let attempt = 0; attempt < 6; attempt++) {
        await page.goto(`${BASE}/?lx=2&run=${RUN}&page=${p}${VS ? `&vs=${VS}` : ''}`, { waitUntil: 'load', timeout: 90000 }).catch(() => {});
        const ok = await page.waitForSelector('.lx-tl-readout, .lx-chart', { timeout: 30000 }).then(() => true).catch(() => false);
        if (ok) break;
        console.log('retry', tag);
        await page.waitForTimeout(5000);
      }
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}${tag}.png` });
      if (FULL) {
        const extra = await page.evaluate(() => { const el = document.querySelector('.lx [data-lx-main]'); return el ? el.scrollHeight - el.clientHeight : 0; });
        if (extra > 4) {
          await page.setViewportSize({ width: W, height: H + extra });
          await page.waitForTimeout(600);
          await page.screenshot({ path: `${OUT}${tag}-full.png` });
        }
      }
      console.log('shot', tag);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(errors.length ? errors.join('\n') : 'no console errors');
