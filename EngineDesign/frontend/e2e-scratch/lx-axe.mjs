// Scratch accessibility pass: axe on the rebuilt Layer X (the .lx root only), each Burn page,
// dark and light. Prints violations by rule.
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const BASE = 'http://localhost:5173';
const runs = await (await fetch('http://localhost:8000/api/layerx/runs')).json();
const run = runs.filter((r) => (r.kind ?? 'run') === 'run' && r.status === 'done').sort((a, b) => b.started - a.started)[0].id;
const pages = (process.env.PAGES ?? 'overview,feed,engine,hardware,flight,stand,uncertainty,record').split(',');
const browser = await chromium.launch();
let total = 0;
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript((t) => { const k = 'engine-design.view.v1'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s['lx.theme'] = t; localStorage.setItem(k, JSON.stringify(s)); }, theme);
  const page = await ctx.newPage();
  for (const p of pages) {
    await page.goto(`${BASE}/?lx=2&run=${run}&page=${p}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.lx-tl-readout');
    await page.waitForTimeout(1200);
    const res = await new AxeBuilder({ page }).include('.lx').analyze();
    total += res.violations.length;
    for (const v of res.violations) {
      console.log(`[${theme}/${p}] ${v.id} (${v.impact}) x${v.nodes.length}: ${v.help}`);
      for (const n of v.nodes.slice(0, 4)) console.log(`    ${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1, 2).join(' ').slice(0, 160)}`);
    }
  }
  await ctx.close();
}
console.log(total ? `${total} violation groups` : 'no axe violations');
await browser.close();
