// Scratch visual QA for lx/hero via the harness page (e2e-scratch/hero.html). Not a test suite.
//   node e2e-scratch/hero-shots.mjs                      -> hero at 1440/1920 widths, dark + light
//   CASES='dark:1100:1.75' QS='&fixture=network' node e2e-scratch/hero-shots.mjs
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = new URL('./shots/', import.meta.url).pathname;
const QS = process.env.QS ?? '';
const TAG = process.env.TAG ?? 'hero';
// theme:viewport:t -- the panel gets the width the Overview gives it at that viewport (the rail
// open: 1440 -> 1104, 1920 -> 1584), and the viewport is the real one so breakpoints match.
const CASES = (process.env.CASES ?? 'dark:1440:1.75,light:1440:1.75,dark:1920:1.75,light:1920:2.9').split(',');
const CONTENT = { 1440: 1104, 1920: 1584 };

const browser = await chromium.launch();
const errors = [];
for (const c of CASES) {
  const [theme, vwText, t] = c.split(':');
  const vw = Number(vwText);
  const w = CONTENT[vw] ?? vw - 336;
  const page = await browser.newPage({ viewport: { width: vw, height: 900 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => errors.push(`${c} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${c} ${m.type()}: ${m.text()}`); });
  await page.goto(`${BASE}/e2e-scratch/hero.html?theme=${theme}&w=${w}&t=${t}${QS}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('svg[aria-label="Feed system schematic"]', { timeout: 60000 });
  await page.waitForTimeout(800);
  const file = `${OUT}${TAG}-${vw}-${theme}-t${t}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(file);
  if (process.env.HOVER) {
    for (const sel of process.env.HOVER.split(',')) {
      const el = page.locator(sel).first();
      await el.hover({ force: true });
      await page.waitForTimeout(400);
      const hf = `${OUT}${TAG}-${vw}-${theme}-hover-${sel.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png`;
      await page.screenshot({ path: hf, fullPage: true });
      console.log(hf);
    }
  }
  await page.close();
}
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
