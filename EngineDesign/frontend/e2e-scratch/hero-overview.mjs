// Scratch: the hero inside the real Overview page (?lx=2), at 1440 and 1920, dark and light.
import { chromium } from 'playwright';
const OUT = new URL('./shots/', import.meta.url).pathname;
const CASES = (process.env.CASES ?? '1440:dark,1440:light,1920:dark,1920:light').split(',');
const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const latest = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started);
const run = process.env.RUN ?? latest[0].id;
const browser = await chromium.launch();
const errors = [];
for (const c of CASES) {
  const [w, theme] = c.split(':');
  const H = Number(w) === 1920 ? 1080 : 900;
  const ctx = await browser.newContext({ viewport: { width: Number(w), height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript((th) => {
    try { const k = 'engine-design.view.v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s['lx.theme'] = th; localStorage.setItem(k, JSON.stringify(s)); } catch {}
  }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${c} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${c} console: ${m.text()}`); });
  await page.goto(`http://localhost:5173/?lx=2&run=${run}&page=overview&t=1.75`, { waitUntil: 'load', timeout: 60000 });
  const hero = page.locator('section:has(svg[aria-label="Feed system schematic"])');
  await hero.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  await hero.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await hero.screenshot({ path: `${OUT}hero-overview-${w}-${theme}.png` });
  await page.screenshot({ path: `${OUT}hero-overview-${w}-${theme}-page.png` });
  console.log(c, await hero.boundingBox());
  await ctx.close();
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
