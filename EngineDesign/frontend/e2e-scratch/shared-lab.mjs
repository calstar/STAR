// Scratch (shared-layers agent): the lab page (e2e-scratch/lab/charts-lab.html) at the given
// sizes/themes/units, with console errors and the geometry checks (overlap, clipped, orphan).
// Env: OUT, SIZES, THEMES, UNITS ("stand,si"), ONLY (lab sections), HOVER (1: also hover shots).
import { chromium } from 'playwright';
import fs from 'node:fs';
import { geometry } from './qa-geometry.mjs';

const OUT = new URL(`./shots/shared/${process.env.OUT ?? 'lab'}/`, import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const SIZES = (process.env.SIZES ?? '1440x900,1920x1080').split(',').map((s) => s.split('x').map(Number));
const THEMES = (process.env.THEMES ?? 'dark,light').split(',');
const UNITS = (process.env.UNITS ?? 'stand').split(',');
const ONLY = process.env.ONLY ?? '';
const browser = await chromium.launch();
const errors = [];
const findings = [];
for (const [W, H] of SIZES) for (const theme of THEMES) for (const units of UNITS) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`${W}-${theme} pageerror ${e.message.slice(0, 300)}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${W}-${theme} ${m.type()} ${m.text().slice(0, 300)}`); });
  const tag = `lab-${W}-${theme}-${units}`;
  await page.goto(`http://localhost:5173/e2e-scratch/lab/charts-lab.html?theme=${theme}&units=${units}${ONLY ? `&only=${ONLY}` : ''}`, { waitUntil: 'load', timeout: 90000 });
  await page.waitForSelector('.lx-chart', { timeout: 60000 });
  await page.waitForTimeout(1200);
  // The cursor at T+1.20 s, through the timeline's slider.
  await page.focus('.lx-tl-handle');
  await page.keyboard.press('Home');
  for (let i = 0; i < 17; i++) await page.keyboard.press('Shift+ArrowRight');
  await page.mouse.move(1, 1);
  await page.waitForTimeout(300);
  // Put the cursor somewhere interesting: T+1.20 s.
  await page.evaluate(() => document.fonts.ready);
  const g = await page.evaluate(geometry, '.lx');
  for (const k of ['overlap', 'clipped', 'orphan']) for (const x of g[k]) findings.push({ tag, k, ...x });
  await page.screenshot({ path: `${OUT}${tag}.png`, fullPage: true });
  if (process.env.HOVER === '1') {
    for (const sel of ['figure[aria-label="Nyquist"] .lx-chart-plot', 'figure[aria-label="Heat flux"] .lx-chart-plot', 'figure[aria-label="Operating map"] .lx-chart-plot']) {
      const el = await page.$(sel);
      if (!el) continue;
      const b = await el.boundingBox();
      await page.mouse.move(b.x + b.width * 0.55, b.y + b.height * 0.45);
      await page.waitForTimeout(200);
    }
    await page.screenshot({ path: `${OUT}${tag}-hover.png`, fullPage: true });
  }
  console.log('shot', tag);
  await page.close();
}
await browser.close();
fs.writeFileSync(`${OUT}findings.json`, JSON.stringify({ errors, findings }, null, 1));
console.log(errors.length ? errors.join('\n') : 'no console errors');
console.log(`${findings.length} geometry findings`);
for (const f of findings.slice(0, 30)) console.log(JSON.stringify(f).slice(0, 300));
